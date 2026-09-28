#!/usr/bin/env node
// Перенос файлов с итогом «Удалить»/«Дубликат» в плоскую папку-карантин рядом с опубликованной.
// Ничего не удаляет. Работает серверным move Яндекс Диска, без скачивания.
//
//   node scripts/quarantine.mjs                      # dry-run: показать план
//   node scripts/quarantine.mjs --apply              # перенести всё из плана
//   node scripts/quarantine.mjs --apply --only d_a,d_b
//   node scripts/quarantine.mjs --rollback [--only d_a] [--apply]   # вернуть по журналу
//   node scripts/quarantine.mjs --confirm            # показать план и спросить «да» (так работает move-to-quarantine.cmd)
//   node scripts/quarantine.mjs --flatten [--apply]  # переложить файлы из подпапок карантина в его корень
//
// Опции: --decisions <v2.json> (по умолчанию ../FrDomianReview-data/review-decisions.json),
//        --manifest <file>, --no-publish-log, --no-rescan.
//
// Карантин плоский: все файлы в одной папке. При совпадении имени к нему добавляется id документа.
// Исходный путь каждого файла хранится в журнале: logs/moves.jsonl (локально, в .gitignore)
// + копия в FrDomianReview-data/logs/moves.jsonl. Откат идёт по журналу.
//
// OAuth-токен владельца Диска — только из переменной окружения или .env: YANDEX_DISK_TOKEN.
// Эти же функции использует локальный помощник scripts/helper.mjs.

import { readFile, appendFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { buildDeletePlan } from './build-delete-plan.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_REPO = path.resolve(ROOT, '..', 'FrDomianReview-data');
const API = 'https://cloud-api.yandex.net/v1/disk';
const LOG_FILE = path.join(ROOT, 'logs', 'moves.jsonl');
const QUARANTINE_PREFIX = '_Карантин ';
export const DEFAULT_DECISIONS = path.join(DATA_REPO, 'review-decisions.json');
export const DEFAULT_MANIFEST = path.join(ROOT, 'data/manifest.json');

export function loadToken() {
    if (process.env.YANDEX_DISK_TOKEN) return process.env.YANDEX_DISK_TOKEN.trim();
    const envFile = path.join(ROOT, '.env');
    if (existsSync(envFile)) {
        const match = /^YANDEX_DISK_TOKEN=(.*)$/m.exec(readFileSync(envFile, 'utf8'));
        if (match && match[1].trim()) return match[1].trim();
    }
    throw new Error('Нет YANDEX_DISK_TOKEN (переменная окружения или .env).');
}

// ---- Яндекс Диск ----

export function createDisk(token) {
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
        list: (p) => call('GET', `${API}/resources?${q({ path: p, limit: 1000, fields: '_embedded.items.path,_embedded.items.type' })}`),
        mkdir: (p) => call('PUT', `${API}/resources?${q({ path: p })}`),
        move: (from, to) => call('POST', `${API}/resources/move?${q({ from, path: to, overwrite: 'false' })}`),
        // Только для пустых папок внутри карантина; permanently=false — в Корзину Диска.
        removeEmptyDir: (p) => call('DELETE', `${API}/resources?${q({ path: p, permanently: 'false' })}`),
        operation: (href) => call('GET', href)
    };
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDir(disk, dirPath, known) {
    if (known.has(dirPath)) return;
    const parent = dirPath.slice(0, dirPath.lastIndexOf('/'));
    if (parent && !parent.endsWith(':')) await ensureDir(disk, parent, known);
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

// Имя в плоском карантине при совпадении: «Имя (d_xxxx).ext».
export function alternateName(filePath, id) {
    const slash = filePath.lastIndexOf('/');
    const dir = filePath.slice(0, slash);
    const name = filePath.slice(slash + 1);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';
    return `${dir}/${stem} (${id})${ext}`;
}

// Перенос одного файла с проверками до и после. item: {id, name, size, md5, from, to, flat}.
// flat: при занятом месте назначения пробуется имя с id. Возвращает запись журнала (без ts/action).
async function moveOne(disk, item, known) {
    const base = { id: item.id, name: item.name, from: item.from, to: item.to, size: item.size, md5: item.md5 };
    const source = await disk.stat(item.from);
    if (source.status === 404) return { ...base, result: 'skipped', reason: 'источника нет на Диске' };
    if (source.status !== 200) return { ...base, result: 'failed', reason: `stat источника: HTTP ${source.status}` };
    if (source.body.type !== 'file') return { ...base, result: 'skipped', reason: 'источник — не файл' };
    if (item.md5 && source.body.md5 !== item.md5) {
        return { ...base, result: 'skipped', reason: 'md5 на Диске не совпадает с манифестом — файл изменился, пересканируйте' };
    }
    let target = item.to;
    if ((await disk.stat(target)).status === 200) {
        if (!item.flat) return { ...base, result: 'skipped', reason: 'в месте назначения уже есть файл' };
        target = alternateName(item.to, item.id);
        if ((await disk.stat(target)).status === 200) {
            return { ...base, result: 'skipped', reason: 'в карантине уже есть файлы с этим именем' };
        }
    }
    base.to = target;

    await ensureDir(disk, target.slice(0, target.lastIndexOf('/')), known);
    const started = Date.now();
    const moved = await disk.move(item.from, target);
    if (moved.status === 202) {
        await waitOperation(disk, moved.body.href);
    } else if (moved.status !== 201) {
        return { ...base, result: 'failed', reason: `move: HTTP ${moved.status} ${(moved.body && moved.body.description) || ''}`.trim() };
    }
    const after = await disk.stat(target);
    const md5Ok = after.status === 200 && after.body.md5 === source.body.md5;
    return {
        ...base,
        result: md5Ok ? 'ok' : 'failed',
        reason: after.status !== 200 ? `stat результата: HTTP ${after.status}` : md5Ok ? '' : 'md5 после переноса не совпадает',
        resource_id_before: source.body.resource_id || null,
        resource_id_after: after.status === 200 ? after.body.resource_id || null : null,
        duration_ms: Date.now() - started
    };
}

// ---- журнал ----

export async function readLog() {
    if (!existsSync(LOG_FILE)) return [];
    return (await readFile(LOG_FILE, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function appendLog(entry) {
    await mkdir(path.dirname(LOG_FILE), { recursive: true });
    await appendFile(LOG_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
}

// Файлы, которые сейчас в карантине: последняя успешная операция по id — перенос туда.
// В записи from — исходный путь в опубликованной папке, to — текущее место в карантине.
export function quarantined(log) {
    const state = new Map();
    log.filter((entry) => entry.result === 'ok').forEach((entry) => state.set(entry.id, entry));
    return Array.from(state.values()).filter((entry) => entry.action === 'quarantine');
}

export async function publishLog() {
    if (!existsSync(path.join(DATA_REPO, '.git'))) {
        return `Копия журнала не опубликована: нет клона ${DATA_REPO}`;
    }
    const git = (...args) => execFileSync('git', ['-C', DATA_REPO, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('pull', '-q', '--ff-only');
    const target = path.join(DATA_REPO, 'logs', 'moves.jsonl');
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(LOG_FILE, target);
    git('add', 'logs/moves.jsonl');
    if (!git('status', '--porcelain', 'logs/moves.jsonl').trim()) return 'Журнал без изменений';
    git('commit', '-q', '-m', 'Update quarantine log');
    git('push', '-q');
    return 'Журнал опубликован в FrDomianReview-data/logs/moves.jsonl';
}

export function rescan() {
    execFileSync(process.execPath, [path.join(ROOT, 'scripts/scan-disk.mjs')], { stdio: ['ignore', 'ignore', 'ignore'] });
}

// ---- сеанс: токен, корни, план ----

export async function openSession(manifestPath = DEFAULT_MANIFEST) {
    const disk = createDisk(loadToken());
    const info = await disk.info();
    if (info.status !== 200) throw new Error(`Токен не принят Диском: HTTP ${info.status}`);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const publicRoot = await disk.publicRoot(manifest.source.public_key);
    if (!publicRoot) throw new Error('Опубликованная папка не найдена на этом Диске — токен не владельца?');
    const parent = publicRoot.slice(0, publicRoot.lastIndexOf('/')) || 'disk:';
    const quarantineRoot = `${parent}/${QUARANTINE_PREFIX}${publicRoot.slice(publicRoot.lastIndexOf('/') + 1)}`;
    return { disk, user: info.body.user.login, manifest, publicRoot, parent, quarantineRoot, manifestPath };
}

export function pullDecisions() {
    if (!existsSync(path.join(DATA_REPO, '.git'))) return false;
    try {
        execFileSync('git', ['-C', DATA_REPO, 'pull', '-q', '--ff-only'], { stdio: 'ignore' });
        return true;
    } catch (error) {
        return false;
    }
}

// План переноса в карантин по решениям v2.
export async function quarantinePlan(session, decisionsPath = DEFAULT_DECISIONS) {
    const docsById = new Map(session.manifest.documents.map((doc) => [doc.id, doc]));
    const decisions = JSON.parse(await readFile(decisionsPath, 'utf8'));
    const { plan, conflicts } = buildDeletePlan(session.manifest, decisions);
    const items = plan.map((row) => ({
        id: row.id,
        name: row.name,
        size: row.size,
        md5: docsById.get(row.id).disk.md5,
        decision: row.decision_status,
        from: `${session.publicRoot}${row.path}`,
        to: `${session.quarantineRoot}/${row.name}`,
        flat: true
    }));
    return { items, conflicts };
}

export function restorePlan(log) {
    return quarantined(log).map((entry) => ({
        id: entry.id, name: entry.name, size: entry.size, md5: entry.md5, from: entry.to, to: entry.from, flat: false
    }));
}

// Файлы, лежащие в подпапках карантина (перенесённые до перехода на плоский карантин).
export function flattenPlan(session, log) {
    return quarantined(log)
        .filter((entry) => entry.to.slice(0, entry.to.lastIndexOf('/')) !== session.quarantineRoot)
        .map((entry) => ({
            id: entry.id, name: entry.name, size: entry.size, md5: entry.md5,
            from: entry.to, to: `${session.quarantineRoot}/${entry.name}`, flat: true, origin: entry.from
        }));
}

// Выполняет перенос. action: 'quarantine' | 'restore'. Возвращает записи журнала.
export async function runMoves(session, items, action, onEntry) {
    const known = new Set([session.parent]);
    const entries = [];
    for (const item of items) {
        let entry;
        try {
            entry = await moveOne(session.disk, item, known);
        } catch (error) {
            entry = { id: item.id, name: item.name, from: item.from, to: item.to, size: item.size, md5: item.md5, result: 'failed', reason: error.message };
        }
        if (item.origin) {
            // Перекладка внутри карантина: исходный путь в опубликованной папке остаётся from.
            entry.relocated_from = entry.from;
            entry.from = item.origin;
        }
        entry = { ts: new Date().toISOString(), action, disk_user: session.user, decision: item.decision || null, ...entry };
        await appendLog(entry);
        entries.push(entry);
        if (onEntry) onEntry(entry);
    }
    return entries;
}

// Удаляет пустые подпапки внутри карантина (папки, в которых нет ни одного файла).
// Возвращает число удалённых папок. Сам корень карантина не трогается.
export async function pruneEmptyDirs(session) {
    let removed = 0;
    async function walk(dir) {
        const { status, body } = await session.disk.list(dir);
        if (status !== 200) return true;
        const items = (body._embedded && body._embedded.items) || [];
        let hasFiles = items.some((item) => item.type === 'file');
        for (const child of items.filter((item) => item.type === 'dir')) {
            if (await walk(child.path)) {
                hasFiles = true;
            } else {
                const result = await session.disk.removeEmptyDir(child.path);
                if (result.status === 204 || result.status === 202) removed += 1;
                else hasFiles = true;
            }
        }
        return hasFiles;
    }
    await walk(session.quarantineRoot);
    return removed;
}

// ---- командная строка ----

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

async function askYes(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise((resolve) => rl.question(question, resolve));
    rl.close();
    return ['да', 'д', 'yes', 'y'].includes(answer.trim().toLowerCase());
}

function parseArgs(argv) {
    const args = { apply: false, confirm: false, mode: 'quarantine', only: null, decisions: DEFAULT_DECISIONS, manifest: DEFAULT_MANIFEST, publishLog: true, rescan: true };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--apply') args.apply = true;
        else if (arg === '--confirm') args.confirm = true;
        else if (arg === '--rollback') args.mode = 'restore';
        else if (arg === '--flatten') args.mode = 'flatten';
        else if (arg === '--only') args.only = new Set(argv[++i].split(',').map((s) => s.trim()).filter(Boolean));
        else if (arg === '--decisions') args.decisions = path.resolve(argv[++i]);
        else if (arg === '--manifest') args.manifest = path.resolve(argv[++i]);
        else if (arg === '--no-publish-log') args.publishLog = false;
        else if (arg === '--no-rescan') args.rescan = false;
        else throw new Error(`Неизвестный аргумент: ${arg}`);
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const session = await openSession(args.manifest);
    console.log(`Диск: ${session.user}\nОпубликованная папка: ${session.publicRoot}\nКарантин: ${session.quarantineRoot}`);

    let items;
    let title;
    if (args.mode === 'restore') {
        items = restorePlan(await readLog());
        title = 'Вернуть из карантина';
    } else if (args.mode === 'flatten') {
        items = flattenPlan(session, await readLog());
        title = 'Переложить в корень карантина';
    } else {
        if (args.decisions === DEFAULT_DECISIONS && !pullDecisions()) {
            console.warn('Не удалось обновить клон FrDomianReview-data — используется локальная версия решений.');
        }
        const plan = await quarantinePlan(session, args.decisions);
        if (plan.conflicts) console.log(`Конфликтов без решения арбитра: ${plan.conflicts} (в план не входят).`);
        items = plan.items;
        title = 'Перенести в карантин';
    }
    if (args.only) {
        const missing = [...args.only].filter((id) => !items.some((item) => item.id === id));
        if (missing.length) console.warn(`Не входят в план: ${missing.join(', ')}`);
        items = items.filter((item) => args.only.has(item.id));
    }

    console.log(`\n${title}: ${items.length} файл(ов), ${formatSize(items.reduce((sum, item) => sum + (item.size || 0), 0))}`);
    items.forEach((item, index) => {
        console.log(`${String(index + 1).padStart(3)}. [${item.id}] ${formatSize(item.size).padStart(9)}  ${item.from}`);
        console.log(`     → ${item.to}`);
    });
    if (!items.length) {
        console.log('\nПереносить нечего.');
        return;
    }
    if (args.confirm && !args.apply) {
        args.apply = await askYes(`\nПеренести ${items.length} файл(ов)? Введите «да» и нажмите Enter: `);
        if (!args.apply) console.log('Отменено, ничего не перенесено.');
    }
    if (!args.apply) {
        if (!args.confirm) console.log('\nЭто dry-run: ничего не перенесено. Для выполнения добавьте --apply.');
        return;
    }

    const action = args.mode === 'restore' ? 'restore' : 'quarantine';
    const entries = await runMoves(session, items, action, (entry) => {
        console.log(`${entry.result.toUpperCase().padEnd(7)} ${entry.name}${entry.reason ? `  (${entry.reason})` : ''}${entry.result === 'ok' ? `  → ${entry.to}` : ''}`);
    });
    const count = (result) => entries.filter((entry) => entry.result === result).length;
    console.log(`\nГотово: успешно ${count('ok')}, пропущено ${count('skipped')}, ошибок ${count('failed')}. Журнал: logs/moves.jsonl`);

    if (args.mode === 'flatten') {
        console.log(`Удалено пустых подпапок в карантине: ${await pruneEmptyDirs(session)}`);
    }
    if (args.publishLog) {
        try {
            console.log(await publishLog());
        } catch (error) {
            console.warn(`Не удалось опубликовать журнал: ${error.message}`);
        }
    }
    if (args.rescan && args.mode !== 'flatten' && count('ok')) {
        console.log('Обновляю manifest.json по Диску…');
        rescan();
    }
    if (count('failed')) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
