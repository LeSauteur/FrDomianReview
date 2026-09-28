#!/usr/bin/env node
// План удаления по решениям v2: какие файлы ещё нужно удалить с Диска.
//
//   node scripts/build-delete-plan.mjs [--decisions ../FrDomianReview-data/review-decisions.json]
//        [--manifest data/manifest.json] [--json reports/delete-plan.json] [--csv reports/delete-plan.csv]
//
// Итог файла считается по правилам v2 (core.effectiveStatus): решение арбитра, иначе
// единогласие голосов; конфликт без решения арбитра в план не попадает.
// В план входят документы с итогом DELETE или DUPLICATE, которые ещё не выполнены:
// файл есть на Диске и нет отметки «Удалено» (core.completionOf). Исходный итог
// сохраняется в decision_status, чтобы удаление и дубликаты оставались различимы.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = createRequire(import.meta.url)(path.join(ROOT, 'review-core.js'));

function parseArgs(argv) {
    const args = {
        decisions: path.resolve(ROOT, '..', 'FrDomianReview-data', 'review-decisions.json'),
        manifest: path.join(ROOT, 'data/manifest.json'),
        json: path.join(ROOT, 'reports/delete-plan.json'),
        csv: path.join(ROOT, 'reports/delete-plan.csv')
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--decisions') args.decisions = path.resolve(argv[++i]);
        else if (arg === '--manifest') args.manifest = path.resolve(argv[++i]);
        else if (arg === '--json') args.json = path.resolve(argv[++i]);
        else if (arg === '--csv') args.csv = path.resolve(argv[++i]);
        else throw new Error(`Неизвестный аргумент: ${arg}`);
    }
    return args;
}

export function buildDeletePlan(manifest, decisions) {
    if (core.isV1(decisions)) {
        throw new Error('Это файл решений v1. Нужен v2 из приватного FrDomianReview-data.');
    }
    if (!decisions || decisions.version !== 2) {
        throw new Error('Файл решений не похож на review-decisions v2.');
    }
    const envelope = core.normalizeEnvelope(decisions);
    const documents = manifest && Array.isArray(manifest.documents) ? manifest.documents : [];
    const docsById = new Map(documents.map((doc) => [doc.id, doc]));

    const unknown = Object.keys(envelope.files).filter((id) => !docsById.has(id));
    if (unknown.length) {
        throw new Error(`Решения ссылаются на id, которых нет в манифесте (${unknown.length}):\n${unknown.join('\n')}`);
    }

    const plan = [];
    let done = 0;
    let conflicts = 0;
    Object.entries(envelope.files).forEach(([id, entry]) => {
        const effective = core.effectiveStatus(entry);
        if (effective.conflict) {
            conflicts += 1;
            return;
        }
        if (!['DELETE', 'DUPLICATE'].includes(effective.status)) {
            return;
        }
        const doc = docsById.get(id);
        const outcome = core.outcomeFor(entry, Boolean(doc.disk && doc.disk.missing_since));
        if (core.completionOf(effective.status, outcome).state === 'done') {
            done += 1;
            return;
        }
        const decidedBy = effective.resolved
            ? entry.resolution.by
            : Object.keys(entry.votes).filter((name) => entry.votes[name].status === effective.status).join(', ');
        const decidedAt = effective.resolved
            ? entry.resolution.at
            : Object.values(entry.votes).map((vote) => vote.at).sort().pop();
        plan.push({
            id,
            decision_status: effective.status,
            path: doc.disk.path,
            name: doc.name,
            size: typeof doc.disk.size === 'number' ? doc.disk.size : null,
            viewer_url: doc.disk.viewer_url || '',
            decided_by: decidedBy,
            decided_at: decidedAt || '',
            resolved_by_arbiter: effective.resolved
        });
    });
    plan.sort((left, right) => left.path.localeCompare(right.path));
    return { plan, done, conflicts };
}

const CSV_FIELDS = ['id', 'decision_status', 'path', 'name', 'size', 'viewer_url', 'decided_by', 'decided_at', 'resolved_by_arbiter'];

export function toCsv(plan) {
    const cell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    return [CSV_FIELDS.map(cell).join(','), ...plan.map((row) => CSV_FIELDS.map((key) => cell(row[key])).join(','))]
        .join('\n') + '\n';
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const readJson = async (file, what) => {
        try {
            return JSON.parse(await readFile(file, 'utf8'));
        } catch (error) {
            throw new Error(`Не удалось прочитать ${what}: ${file}\n${error.message}`);
        }
    };
    const manifest = await readJson(args.manifest, 'манифест');
    const decisions = await readJson(args.decisions, 'файл решений v2');
    const { plan, done, conflicts } = buildDeletePlan(manifest, decisions);

    await mkdir(path.dirname(args.json), { recursive: true });
    await mkdir(path.dirname(args.csv), { recursive: true });
    await writeFile(args.json, JSON.stringify(plan, null, 2) + '\n');
    await writeFile(args.csv, toCsv(plan));

    console.log(`DELETE_TO_DO: ${plan.length}`);
    console.log(`DELETE_DONE: ${done}`);
    console.log(`CONFLICTS_UNRESOLVED: ${conflicts}`);
    console.log('DELETE_PLAN_CREATED: YES');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
