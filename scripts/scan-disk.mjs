#!/usr/bin/env node
// Сканирует публичную папку Яндекс Диска (без OAuth) и обновляет data/manifest.json.
//
//   node scripts/scan-disk.mjs                      # обновить манифест по Диску
//   node scripts/scan-disk.mjs --seed-index <file>  # первый запуск: взять id/пути из старого индекса
//   node scripts/scan-disk.mjs --offline            # без сети: только пересобрать из seed-индекса
//
// id документа назначается один раз и не меняется. При повторном сканировании файл
// сопоставляется с документом по resource_id, затем по текущему/прежним путям,
// затем по md5 (только если совпадение единственное). Каталожные поля
// (title, section, tags, lifecycle, actual_as_of, owner) сканер не перезаписывает.
// Документы, пропавшие с Диска, не удаляются — получают disk.missing_since.

import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PUBLIC_KEY = 'a7Jr1RaNr9gXWDpu6hEE2oqj+rip5HCmHrZnkC+BCQqa+TWx8hS7vhd4zf7doQTxq/J6bpmRyOJonT3VoXnDag==';
const API = 'https://cloud-api.yandex.net/v1/disk/public/resources';
const PAGE = 1000;
const CONCURRENCY = 4;

function parseArgs(argv) {
    const args = { manifest: path.join(ROOT, 'data/manifest.json'), seedIndex: null, offline: false, publicKey: DEFAULT_PUBLIC_KEY };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--manifest') args.manifest = path.resolve(argv[++i]);
        else if (arg === '--seed-index') args.seedIndex = path.resolve(argv[++i]);
        else if (arg === '--public-key') args.publicKey = argv[++i];
        else if (arg === '--offline') args.offline = true;
        else throw new Error(`Неизвестный аргумент: ${arg}`);
    }
    return args;
}

async function readJson(file) {
    try {
        return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

function newId(taken) {
    const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
    for (;;) {
        const id = 'd_' + Array.from(randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join('');
        if (!taken.has(id)) {
            taken.add(id);
            return id;
        }
    }
}

function encodeStrict(value) {
    return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function viewerUrl(publicKey, filePath, name) {
    return `https://docs.yandex.ru/docs/view?url=${encodeStrict(`ya-disk-public://${publicKey}:${filePath}`)}&name=${encodeStrict(name)}`;
}

function extensionOf(name) {
    const match = /\.([^./]+)$/.exec(name);
    return match ? match[1].toLowerCase() : '';
}

function titleOf(name) {
    return name.replace(/\.[^./]+$/, '').trim() || name;
}

async function fetchJson(url, attempt = 0) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if ((response.status === 429 || response.status >= 500) && attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        return fetchJson(url, attempt + 1);
    }
    if (!response.ok) {
        throw new Error(`Диск API: HTTP ${response.status} для ${url}`);
    }
    return response.json();
}

async function listFolder(publicKey, folderPath) {
    const items = [];
    for (let offset = 0; ; offset += PAGE) {
        const url = `${API}?public_key=${encodeURIComponent(publicKey)}&path=${encodeURIComponent(folderPath)}`
            + `&limit=${PAGE}&offset=${offset}&preview_crop=false`;
        const data = await fetchJson(url);
        const embedded = data._embedded || { items: [], total: 0 };
        items.push(...embedded.items);
        if (offset + PAGE >= embedded.total) {
            return { root: data, items };
        }
    }
}

// Обход дерева папок с ограниченной параллельностью. Возвращает записи файлов.
async function scanDisk(publicKey) {
    const files = [];
    let rootName = null;
    const queue = ['/'];
    let active = 0;
    let folders = 0;
    await new Promise((resolve, reject) => {
        const pump = () => {
            if (!queue.length && active === 0) {
                resolve();
                return;
            }
            while (queue.length && active < CONCURRENCY) {
                const folder = queue.shift();
                active += 1;
                listFolder(publicKey, folder).then(({ root, items }) => {
                    folders += 1;
                    if (folder === '/') rootName = root.name;
                    for (const item of items) {
                        if (item.type === 'dir') {
                            queue.push(item.path);
                        } else {
                            files.push(fileRecord(item));
                        }
                    }
                    process.stderr.write(`\rпапок: ${folders}, файлов: ${files.length}   `);
                    active -= 1;
                    pump();
                }, reject);
            }
        };
        pump();
    });
    process.stderr.write('\n');
    return { rootName, files };
}

function fileRecord(item) {
    return {
        path: item.path,
        name: item.name,
        resource_id: item.resource_id || null,
        size: typeof item.size === 'number' ? item.size : null,
        md5: item.md5 || null,
        sha256: item.sha256 || null,
        mime: item.mime_type || null,
        created: item.created || null,
        modified: item.modified || null
    };
}

function seedFromIndex(index) {
    return index
        .filter((entry) => entry && entry.type === 'file')
        .map(fileRecord);
}

function makeDocument(id, file) {
    return {
        id,
        title: titleOf(file.name),
        name: file.name,
        ext: extensionOf(file.name),
        mime: file.mime,
        section: null,
        tags: [],
        lifecycle: 'pending',
        actual_as_of: null,
        owner: null,
        disk: {},
        history: { original_path: file.path, previous_paths: [] }
    };
}

function applyDiskFacts(doc, file, publicKey, missingSince) {
    const previousPath = doc.disk && doc.disk.path;
    if (previousPath && previousPath !== file.path) {
        const history = doc.history;
        if (!history.previous_paths.includes(previousPath)) history.previous_paths.push(previousPath);
    }
    doc.name = file.name;
    doc.ext = extensionOf(file.name);
    doc.mime = file.mime || doc.mime || null;
    doc.disk = {
        path: file.path,
        resource_id: file.resource_id || (doc.disk && doc.disk.resource_id) || null,
        size: file.size,
        md5: file.md5 || null,
        sha256: file.sha256 || (doc.disk && doc.disk.sha256) || null,
        created: file.created,
        modified: file.modified,
        public_url: (doc.disk && doc.disk.public_url) || null,
        viewer_url: viewerUrl(publicKey, file.path, file.name),
        missing_since: missingSince
    };
}

// Сопоставляет найденные файлы с документами манифеста; возвращает новый список документов.
export function reconcile(documents, files, publicKey, now) {
    const taken = new Set(documents.map((doc) => doc.id));
    const byResource = new Map();
    const byPath = new Map();
    const byMd5 = new Map();
    documents.forEach((doc) => {
        if (doc.disk && doc.disk.resource_id) byResource.set(doc.disk.resource_id, doc);
        [doc.disk && doc.disk.path, doc.history.original_path, ...doc.history.previous_paths]
            .filter(Boolean)
            .forEach((p) => { if (!byPath.has(p)) byPath.set(p, doc); });
        if (doc.disk && doc.disk.md5) {
            const list = byMd5.get(doc.disk.md5) || [];
            list.push(doc);
            byMd5.set(doc.disk.md5, list);
        }
    });

    const matched = new Set();
    const result = [];
    const stats = { matched_resource: 0, matched_path: 0, matched_md5: 0, added: 0, missing: 0 };
    const pending = [];

    const take = (doc, file, kind) => {
        matched.add(doc.id);
        applyDiskFacts(doc, file, publicKey, null);
        result.push(doc);
        stats[kind] += 1;
    };

    for (const file of files) {
        const doc = file.resource_id && byResource.get(file.resource_id);
        if (doc && !matched.has(doc.id)) take(doc, file, 'matched_resource');
        else pending.push(file);
    }
    const stillPending = [];
    for (const file of pending) {
        const doc = byPath.get(file.path);
        if (doc && !matched.has(doc.id)) take(doc, file, 'matched_path');
        else stillPending.push(file);
    }
    for (const file of stillPending) {
        const candidates = (file.md5 && byMd5.get(file.md5) || []).filter((doc) => !matched.has(doc.id));
        if (candidates.length === 1) {
            take(candidates[0], file, 'matched_md5');
            continue;
        }
        const doc = makeDocument(newId(taken), file);
        applyDiskFacts(doc, file, publicKey, null);
        result.push(doc);
        stats.added += 1;
    }
    for (const doc of documents) {
        if (!matched.has(doc.id)) {
            doc.disk.missing_since = doc.disk.missing_since || now;
            result.push(doc);
            stats.missing += 1;
        }
    }
    result.sort((a, b) => a.disk.path.localeCompare(b.disk.path, 'ru') || a.id.localeCompare(b.id));
    return { documents: result, stats };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const now = new Date().toISOString();
    const existing = await readJson(args.manifest);
    let documents = existing && Array.isArray(existing.documents) ? existing.documents : [];
    let rootName = existing && existing.source ? existing.source.root_name : null;
    let seedStats = null;

    if (args.seedIndex) {
        const index = await readJson(args.seedIndex);
        if (!Array.isArray(index)) throw new Error(`Не удалось прочитать индекс ${args.seedIndex}`);
        const rootEntry = index.find((entry) => entry.path === '/');
        rootName = rootName || (rootEntry && rootEntry.name) || null;
        const seeded = reconcile(documents, seedFromIndex(index), args.publicKey, now);
        documents = seeded.documents;
        seedStats = seeded.stats;
    }

    let scanStats = null;
    let scannedAt = existing && existing.source ? existing.source.scanned_at : null;
    if (!args.offline) {
        const scan = await scanDisk(args.publicKey);
        rootName = scan.rootName || rootName;
        const reconciled = reconcile(documents, scan.files, args.publicKey, now);
        documents = reconciled.documents;
        scanStats = reconciled.stats;
        scannedAt = now;
    }

    const manifest = {
        schema: 1,
        generated_at: now,
        source: { public_key: args.publicKey, root_name: rootName, scanned_at: scannedAt },
        sections: existing && Array.isArray(existing.sections) ? existing.sections : [],
        documents
    };
    await writeFile(args.manifest, `${JSON.stringify(manifest, null, 1)}\n`, 'utf8');
    console.log(JSON.stringify({ documents: documents.length, seed: seedStats, scan: scanStats }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

