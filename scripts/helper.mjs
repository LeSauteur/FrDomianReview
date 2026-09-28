#!/usr/bin/env node
// Локальный помощник карантина: даёт странице ревизии кнопки «В карантин» и «Вернуть».
//
//   node scripts/helper.mjs        (или двойной щелчок по start-quarantine-helper.cmd)
//
// Слушает только 127.0.0.1:8787 и принимает запросы только со страницы ревизии
// (проверка Origin и Host). Токен Яндекса берётся из .env и никуда не передаётся:
// странице возвращаются только результаты переноса.
// Переносятся только файлы из плана (итог «Удалить»/«Дубликат» по решениям в FrDomianReview-data),
// с теми же проверками и журналом, что и scripts/quarantine.mjs.

import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
    ROOT, openSession, pullDecisions, quarantinePlan, restorePlan, readLog, quarantined, runMoves, publishLog
} from './quarantine.mjs';

const PORT = 8787;
const ALLOWED_ORIGINS = new Set([
    'https://lesauteur.github.io',
    'http://localhost:8765',
    'http://127.0.0.1:8765'
]);
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

let busy = false;
let rescanRunning = false;

function send(res, status, body, origin) {
    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    };
    if (origin) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers.Vary = 'Origin';
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (chunk) => {
            data += chunk;
            if (data.length > 100000) {
                reject(new Error('слишком большой запрос'));
                req.destroy();
            }
        });
        req.on('end', () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            } catch (error) {
                reject(new Error('некорректный JSON'));
            }
        });
    });
}

function requestedIds(body) {
    if (!body || !Array.isArray(body.ids) || body.ids.length === 0) {
        throw new Error('не переданы id файлов');
    }
    return new Set(body.ids.filter((id) => typeof id === 'string' && /^d_[a-z0-9]+$/.test(id)));
}

// Пересканирование Диска после переноса — в фоне, чтобы не задерживать ответ странице.
function rescanInBackground() {
    if (rescanRunning) return;
    rescanRunning = true;
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts/scan-disk.mjs')], { stdio: 'ignore' });
    child.on('exit', () => {
        rescanRunning = false;
        console.log('manifest.json обновлён по Диску');
    });
}

function logEntry(entry) {
    console.log(`${new Date().toLocaleTimeString('ru-RU')} ${entry.action === 'restore' ? 'ВОЗВРАТ ' : 'КАРАНТИН'} ${entry.result.toUpperCase().padEnd(7)} ${entry.name}${entry.reason ? `  (${entry.reason})` : ''}`);
}

async function status() {
    const session = await openSession();
    return {
        ok: true,
        user: session.user,
        quarantine_root: session.quarantineRoot,
        quarantined: quarantined(await readLog()).map((entry) => ({ id: entry.id, to: entry.to, at: entry.ts }))
    };
}

async function moveToQuarantine(ids) {
    const session = await openSession();
    const pulled = pullDecisions();
    const { items } = await quarantinePlan(session);
    const selected = items.filter((item) => ids.has(item.id));
    const notInPlan = [...ids].filter((id) => !selected.some((item) => item.id === id));
    const entries = await runMoves(session, selected, 'quarantine', logEntry);
    return { entries, not_in_plan: notInPlan, decisions_pulled: pulled };
}

async function restoreFromQuarantine(ids) {
    const session = await openSession();
    const items = restorePlan(await readLog()).filter((item) => ids.has(item.id));
    const notInQuarantine = [...ids].filter((id) => !items.some((item) => item.id === id));
    const entries = await runMoves(session, items, 'restore', logEntry);
    return { entries, not_in_quarantine: notInQuarantine };
}

async function afterMoves(entries) {
    if (!entries.some((entry) => entry.result === 'ok')) return;
    try {
        console.log(await publishLog());
    } catch (error) {
        console.warn(`Не удалось опубликовать журнал: ${error.message}`);
    }
    rescanInBackground();
}

const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (!ALLOWED_HOSTS.has(req.headers.host) || !origin || !ALLOWED_ORIGINS.has(origin)) {
        send(res, 403, { ok: false, error: 'запрос не со страницы ревизии' });
        return;
    }
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': origin,
            'Access-Control-Allow-Methods': 'GET, POST',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Allow-Private-Network': 'true',
            'Access-Control-Max-Age': '600',
            Vary: 'Origin'
        });
        res.end();
        return;
    }
    try {
        if (req.method === 'GET' && req.url === '/status') {
            send(res, 200, await status(), origin);
            return;
        }
        if (req.method === 'POST' && (req.url === '/quarantine' || req.url === '/restore')) {
            if (busy) {
                send(res, 409, { ok: false, error: 'помощник занят предыдущим переносом' }, origin);
                return;
            }
            busy = true;
            try {
                const ids = requestedIds(await readBody(req));
                const result = req.url === '/quarantine' ? await moveToQuarantine(ids) : await restoreFromQuarantine(ids);
                send(res, 200, { ok: true, ...result }, origin);
                afterMoves(result.entries);
            } finally {
                busy = false;
            }
            return;
        }
        send(res, 404, { ok: false, error: 'неизвестный запрос' }, origin);
    } catch (error) {
        send(res, 500, { ok: false, error: error.message }, origin);
    }
});

server.listen(PORT, '127.0.0.1', async () => {
    try {
        const info = await status();
        console.log(`Помощник карантина запущен: http://127.0.0.1:${PORT}`);
        console.log(`Диск: ${info.user}. Карантин: ${info.quarantine_root}. Сейчас в карантине: ${info.quarantined.length}.`);
        console.log('Откройте страницу ревизии — там появятся кнопки «В карантин». Не закрывайте это окно.');
    } catch (error) {
        console.error(`Ошибка: ${error.message}`);
        process.exit(1);
    }
});

server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `Порт ${PORT} занят — помощник уже запущен?` : error.message);
    process.exit(1);
});
