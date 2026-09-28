#!/usr/bin/env node
// Переводит review-decisions.json из v1 (ключ — путь, один статус) в v2 (ключ — id, голоса).
//
//   node scripts/migrate-decisions.mjs --in <v1.json> --out <v2.json>
//        [--manifest data/manifest.json] [--legacy-author "Егупов Алексей"] [--merge-into <v2.json>]
//
// Проверяет, что каждое решение и каждый комментарий v1 попали в v2; иначе завершается с ошибкой
// и ничего не записывает.

import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = createRequire(import.meta.url)(path.join(ROOT, 'review-core.js'));

function parseArgs(argv) {
    const args = { manifest: path.join(ROOT, 'data/manifest.json'), legacyAuthor: core.LEGACY_AUTHOR };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--in') args.input = path.resolve(argv[++i]);
        else if (arg === '--out') args.output = path.resolve(argv[++i]);
        else if (arg === '--manifest') args.manifest = path.resolve(argv[++i]);
        else if (arg === '--legacy-author') args.legacyAuthor = argv[++i];
        else if (arg === '--merge-into') args.mergeInto = path.resolve(argv[++i]);
        else throw new Error(`Неизвестный аргумент: ${arg}`);
    }
    if (!args.input || !args.output) {
        throw new Error('Нужны --in и --out.');
    }
    return args;
}

export function migrate(v1, manifest, legacyAuthor) {
    if (!core.isV1(v1)) {
        throw new Error('Входной файл не похож на review-decisions v1.');
    }
    const pathIndex = core.buildPathIndex(manifest);
    const { envelope, unmatched, converted } = core.convertV1Envelope(v1, (p) => pathIndex.get(p) || null, { legacyAuthor });
    if (unmatched.length) {
        throw new Error(`Пути без документа в манифесте (${unmatched.length}):\n${unmatched.join('\n')}`);
    }

    // Сверка: каждое решение v1 с датой — голос автора с тем же статусом; каждый комментарий на месте.
    const problems = [];
    let votes = 0;
    let comments = 0;
    Object.entries(v1.files).forEach(([p, decision]) => {
        const entry = envelope.files[pathIndex.get(p)];
        const expected = core.convertV1Decision(decision, legacyAuthor);
        Object.entries(expected.votes).forEach(([author, vote]) => {
            votes += 1;
            const actual = entry && entry.votes[author];
            if (!actual || actual.status !== vote.status || actual.at !== vote.at) {
                problems.push(`голос ${author} потерян: ${p}`);
            }
        });
        expected.comments.forEach((comment) => {
            comments += 1;
            if (!entry || !entry.comments.some((c) => c.id === comment.id)) {
                problems.push(`комментарий ${comment.id} потерян: ${p}`);
            }
        });
    });
    if (problems.length) {
        throw new Error(`Сверка не пройдена:\n${problems.join('\n')}`);
    }
    return { envelope, report: { v1_entries: Object.keys(v1.files).length, converted, votes, comments, documents: Object.keys(envelope.files).length } };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const v1 = JSON.parse(await readFile(args.input, 'utf8'));
    const manifest = JSON.parse(await readFile(args.manifest, 'utf8'));
    const { envelope, report } = migrate(v1, manifest, args.legacyAuthor);
    let output = envelope;
    if (args.mergeInto) {
        output = core.mergeEnvelopes(JSON.parse(await readFile(args.mergeInto, 'utf8')), envelope);
    }
    output.updated_at = new Date().toISOString();
    await writeFile(args.output, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ ...report, legacy_author: args.legacyAuthor, output: path.relative(ROOT, args.output) }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
