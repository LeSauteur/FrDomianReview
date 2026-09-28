#!/usr/bin/env node
// Перенос файлов с итогом «Удалить»/«Дубликат» в папку-карантин вне опубликованной папки.
// Ничего не удаляет. Работает серверным move Яндекс Диска, без скачивания.
//
//   node scripts/quarantine.mjs                      # dry-run: показать план
//   node scripts/quarantine.mjs --apply              # перенести всё из плана
//   node scripts/quarantine.mjs --apply --only d_a,d_b
//   node scripts/quarantine.mjs --rollback [--only d_a]   # вернуть по журналу (по умолчанию dry-run)
//   node scripts/quarantine.mjs --rollback --apply
//
// Опции: --decisions <v2.json> (по умолчанию ../FrDomianReview-data/review-decisions.json),
//        --manifest <file>, --no-publish-log, --no-rescan.
//
// OAuth-токен владельца Диска — только из переменной окружения или .env: YANDEX_DISK_TOKEN.
// Журнал: logs/moves.jsonl (локально, в .gitignore) + копия в FrDomianReview-data/logs/moves.jsonl.

import { readFile, appendFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDeletePlan } from './build-delete-plan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_REPO = path.resolve(ROOT, '..', 'FrDomianReview-data');
const API = 'https://cloud-api.yandex.net/v1/disk';
const LOG_FILE = path.join(ROOT, 'logs', 'moves.jsonl');
const QUARANTINE_PREFIX = '_Карантин ';

function parseArgs(argv) {
    const args = {
        apply: false,
        rollback: false,
        only: null,
        decisions: path.join(DATA_REPO, 'review-decisions.json'),
        manifest: path.join(ROOT, 'data/manifest.json'),
        publishLog: true,
        rescan: true
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--apply') args.apply = true;
        else if (arg === '--rollback') args.rollback = true;
        else if (arg === '--only') args.only = new Set(argv[++i].split(',').map((s) => s.trim()).filter(Boolean));
        else if (arg === '--decisions') args.decisions = path.resolve(argv[++i]);
        else if (arg === '--manifest') args.manifest = path.resolve(argv[++i]);
        else if (arg === '--no-publish-log') args.publishLog = false;
        else if (arg === '--no-rescan') args.rescan = false;
        else throw new Error(`Неизвестный аргумент: ${arg}`);
    }
    return args;
}

function loadToken() {
    if (process.env.YANDEX_DISK_TOKEN) return process.env.YANDEX_DISK_TOKEN.trim();
    const envFile = path.join(ROOT, '.env');
    if (existsSync(envFile)) {
        const match = /^YANDEX_DISK_TOKEN=(.*)$/m.exec(readFileSync(envFile, 'utf8'));
        if (match && match[1].trim()) return match[1].trim();
    }
    throw new Error('Нет YANDEX_DISK_TOKEN (переменная окружения или .env).');
}

// ---- Яндекс Диск ----

function createDisk(token) {
    const headers = { Authorization: `OAuth ${token}`, Accept: 'application/json' };
    async function call(method, url, attempt = 0) {
        const response = await fetch(url, { method, headers });
        if ((response.status === 429 || response.status >= 500) && attempt < 5) {
            await sleep(1000 * 2 ** attempt);
            return call(method, url, attempt + 1);
        }
        const text = await response.text();
        return { status: response.status, body: text ? JSON.parse(text) : null };
    }
    const q = (params) => new URLSearchParams(params).toString();
    return {
        info: () => call('GET', `${API}?fields=user.login`),
        publicRoot: async (publicKey) => {
            for (let offset = 0; ; offset += 100) {
                const { status, body } = await call('GET', `${API}/resources/public?${q({ type: 'dir', limit: 100, offset, fields: 'items.path,items.public_key' })}`);
                if (status !== 200) throw new Error(`resources/public: HTTP ${status}`);
                const found = body.items.find((item) => item.public_key === publicKey);
                if (found) return found.path;
                if (body.items.length < 100) return null;
            }
        },
        stat: (p) => call('GET', `${API}/resources?${q({ path: p, fields: 'path,type,md5,size,resource_id', limit: 0 })}`),
        mkdir: (p) => call('PUT', `${API}/resources?${q({ path: p })}`),
        move: (from, to) => call('POST', `${API}/resources/move?${q({ from, to, overwrite: 'false' })}`),
        operation: (href) => call('GET', href)
    };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDir(disk, dirPath, known) {
    if (known.has(dirPath)) return;
    const parent = dirPath.slice(0, dirPath.lastIndexOf('/'));
    if (parent && parent !== 'disk:' && !parent.endsWith(':')) await ensureDir(disk, parent, known);
    const { status } = await disk.mkdir(dirPath);
    if (status !== 201 && status !== 409) throw new Error(`Не удалось создать папку ${dirPath}: HTTP ${status}`);
    known.add(dirPath);
}

async function waitOperation(disk, href) {
    const started = Date.now();
    for (let delay = 500; Date.now() - started < 30 * 60 * 1000; delay = Math.min(delay * 2, 10000)) {
        await sleep(delay);
        const { status, body } = await disk.operation(href);
        if (status !== 200) throw new Error(`operation: HTTP ${status}`);
        if (body.status === 'success') return;
        if (body.status === 'failed') throw new Error('операция перемещения завершилась ошибкой');
    }
    throw new Error('операция перемещения не завершилась за 30 минут');
}

// Перенос одного файла с проверками до и после. Возвращает запись журнала.
async function moveOne(disk, item, known) {
    const base = { id: item.id, name: item.name, from: item.from, to: item.to, size: item.size, md5: item.md5 };
    const source = await disk.stat(item.from);
    if (source.status === 404) return { ...base, result: 'skipped', reason: 'источника нет на Диске' };
    if (source.status !== 200) return { ...base, result: 'failed', reason: `stat источника: HTTP ${source.status}` };
    if (source.body.type !== 'file') return { ...base, result: 'skipped', reason: 'источник — не файл' };
    if (item.md5 && source.body.md5 !== item.md5) {
        return { ...base, result: 'skipped', reason: 'md5 на Диске не совпадает с манифестом — файл изменился, пересканируйте' };
    }
    const target = await disk.stat(item.to);
    if (target.status === 200) return { ...base, result: 'skipped', reason: 'в месте назначения уже есть файл' };

    await ensureDir(disk, item.to.slice(0, item.to.lastIndexOf('/')), known);
    const started = Date.now();
    const moved = await disk.move(item.from, item.to);
    if (moved.status === 202) {
        await waitOperation(disk, moved.body.href);
    } else if (moved.status !== 201) {
        return { ...base, result: 'failed', reason: `move: HTTP ${moved.status} ${moved.body && moved.body.description || ''}`.trim() };
    }
    const after = await disk.stat(item.to);
    return {
        ...base,
        result: after.status === 200 && after.body.md5 === source.body.md5 ? 'ok' : 'failed',
        reason: after.status === 200 ? (after.body.md5 === source.body.md5 ? '' : 'md5 после переноса не совпадает') : `stat результата: HTTP ${after.status}`,
        resource_id_before: source.body.resource_id || null,
        resource_id_after: after.status === 200 ? after.body.resource_id || null : null,
        duration_ms: Date.now() - started
    };
}

// ---- журнал ----

async function readLog() {
    if (!existsSync(LOG_FILE)) return [];
    return (await readFile(LOG_FILE, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function appendLog(entry) {
    await mkdir(path.dirname(LOG_FILE), { recursive: true });
    await appendFile(LOG_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
}

// Файлы, которые сейчас в карантине: последняя успешная операция по id — перенос туда.
export function quarantined(log) {
    const state = new Map();
    log.filter((entry) => entry.result === 'ok').forEach((entry) => state.set(entry.id, entry));
    return Array.from(state.values()).filter((entry) => entry.action === 'quarantine');
}

async function publishLog() {
    if (!existsSync(path.join(DATA_REPO, '.git'))) {
        console.warn(`Копия журнала не опубликована: нет клона ${DATA_REPO}`);
        return;
    }
    const git = (...args) => execFileSync('git', ['-C', DATA_REPO, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('pull', '-q', '--ff-only');
    const target = path.join(DATA_REPO, 'logs', 'moves.jsonl');
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(LOG_FILE, target);
    git('add', 'logs/moves.jsonl');
    if (!git('status', '--porcelain', 'logs/moves.jsonl').trim()) return;
    git('commit', '-q', '-m', 'Update quarantine log');
    git('push', '-q');
    console.log('Журнал опубликован в FrDomianReview-data/logs/moves.jsonl');
}

// ---- вывод ----

function formatSize(bytes) {
    if (typeof bytes !== 'number') return '—';
    const units = ['Б', 'КБ', 'МБ', 'ГБ'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function printPlan(title, items) {
    console.log(`\n${title}: ${items.length} файл(ов), ${formatSize(items.reduce((sum, item) => sum + (item.size || 0), 0))}`);
    items.forEach((item, index) => {
        console.log(`${String(index + 1).padStart(3)}. [${item.id}] ${formatSize(item.size).padStart(9)}  ${item.from}`);
        console.log(`     → ${item.to}`);
    });
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const disk = createDisk(loadToken());
    const manifest = JSON.parse(await readFile(args.manifest, 'utf8'));
    const docsById = new Map(manifest.documents.map((doc) => [doc.id, doc]));

    const info = await disk.info();
    if (info.status !== 200) throw new Error(`Токен не принят Диском: HTTP ${info.status}`);
    const publicRoot = await disk.publicRoot(manifest.source.public_key);
    if (!publicRoot) throw new Error('Опубликованная папка не найдена на этом Диске — токен не владельца?');
    const parent = publicRoot.slice(0, publicRoot.lastIndexOf('/')) || 'disk:';
    const quarantineRoot = `${parent}/${QUARANTINE_PREFIX}${publicRoot.slice(publicRoot.lastIndexOf('/') + 1)}`;
    console.log(`Диск: ${info.body.user.login}\nОпубликованная папка: ${publicRoot}\nКарантин: ${quarantineRoot}`);

    let items;
    let action;
    if (args.rollback) {
        action = 'restore';
        items = quarantined(await readLog())
            .filter((entry) => !args.only || args.only.has(entry.id))
            .map((entry) => ({ id: entry.id, name: entry.name, size: entry.size, md5: entry.md5, from: entry.to, to: entry.from }));
    } else {
        action = 'quarantine';
        if (existsSync(path.join(DATA_REPO, '.git')) && args.decisions.startsWith(DATA_REPO)) {
            try {
                execFileSync('git', ['-C', DATA_REPO, 'pull', '-q', '--ff-only'], { stdio: 'ignore' });
            } catch (error) {
                console.warn('Не удалось обновить клон FrDomianReview-data — используется локальная версия решений.');
            }
        }
        const decisions = JSON.parse(await readFile(args.decisions, 'utf8'));
        const { plan, conflicts } = buildDeletePlan(manifest, decisions);
        if (conflicts) console.log(`Конфликтов без решения арбитра: ${conflicts} (в план не входят).`);
        items = plan
            .filter((row) => !args.only || args.only.has(row.id))
            .map((row) => ({
                id: row.id,
                name: row.name,
                size: row.size,
                md5: docsById.get(row.id).disk.md5,
                decision: row.decision_status,
                from: `${publicRoot}${row.path}`,
                to: `${quarantineRoot}${row.path}`
            }));
    }
    if (args.only) {
        const missing = [...args.only].filter((id) => !items.some((item) => item.id === id));
        if (missing.length) console.warn(`Не входят в план: ${missing.join(', ')}`);
    }

    printPlan(action === 'restore' ? 'Вернуть из карантина' : 'Перенести в карантин', items);
    if (!args.apply) {
        console.log('\nЭто dry-run: ничего не перенесено. Для выполнения добавьте --apply.');
        return;
    }
    if (!items.length) return;

    const known = new Set([parent]);
    const summary = { ok: 0, skipped: 0, failed: 0 };
    for (const item of items) {
        let entry;
        try {
            entry = await moveOne(disk, item, known);
        } catch (error) {
            entry = { id: item.id, name: item.name, from: item.from, to: item.to, size: item.size, md5: item.md5, result: 'failed', reason: error.message };
        }
        entry = { ts: new Date().toISOString(), action, disk_user: info.body.user.login, decision: item.decision || null, ...entry };
        await appendLog(entry);
        summary[entry.result] += 1;
        console.log(`${entry.result.toUpperCase().padEnd(7)} ${item.from}${entry.reason ? `  (${entry.reason})` : ''}`);
    }
    console.log(`\nГотово: перенесено ${summary.ok}, пропущено ${summary.skipped}, ошибок ${summary.failed}. Журнал: logs/moves.jsonl`);

    if (args.publishLog) {
        try {
            await publishLog();
        } catch (error) {
            console.warn(`Не удалось опубликовать журнал: ${error.message}`);
        }
    }
    if (args.rescan && summary.ok) {
        console.log('\nОбновляю manifest.json по Диску…');
        execFileSync(process.execPath, [path.join(ROOT, 'scripts/scan-disk.mjs')], { stdio: 'inherit' });
    }
    if (summary.failed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
