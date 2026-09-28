import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../scripts/migrate-decisions.mjs';
import { reconcile } from '../scripts/scan-disk.mjs';
import { quarantined } from '../scripts/quarantine.mjs';
import { buildDeletePlan, toCsv } from '../scripts/build-delete-plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = createRequire(import.meta.url)(path.join(root, 'review-core.js'));
const readJson = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const manifest = readJson('data/manifest.json');

const T1 = '2026-09-11T10:00:00.000Z';
const T2 = '2026-09-11T11:00:00.000Z';
const T3 = '2026-09-11T12:00:00.000Z';

test('manifest: уникальные id и пути, ссылки и хэши у всех найденных файлов', () => {
    const ids = new Set();
    const paths = new Set();
    assert.equal(manifest.schema, 1);
    assert.ok(manifest.documents.length > 0);
    manifest.documents.forEach((doc) => {
        assert.match(doc.id, /^d_[a-z2-9]{8}$/);
        assert.ok(!ids.has(doc.id), `повтор id ${doc.id}`);
        ids.add(doc.id);
        assert.ok(!paths.has(doc.disk.path), `повтор пути ${doc.disk.path}`);
        paths.add(doc.disk.path);
        assert.ok(doc.history.original_path);
        if (!doc.disk.missing_since) {
            assert.match(doc.disk.viewer_url, /^https:\/\/docs\.yandex\.ru\/docs\/view\?url=ya-disk-public%3A%2F%2F/);
            assert.ok(doc.disk.md5 && doc.disk.sha256, `нет хэшей: ${doc.disk.path}`);
        }
    });
});

test('миграция v1 → v2 реальных решений без потерь', { skip: !existsSync(path.join(root, 'data/review-decisions.json')) }, () => {
    const v1 = readJson('data/review-decisions.json');
    const { envelope } = migrate(v1, manifest, core.LEGACY_AUTHOR);
    const index = core.buildPathIndex(manifest);
    Object.entries(v1.files).forEach(([p, d]) => {
        const entry = envelope.files[index.get(p)];
        const author = d.reviewer || core.LEGACY_AUTHOR;
        assert.equal(entry.votes[author].status, d.status);
        assert.equal(core.effectiveStatus(entry).status, d.status);
    });
    assert.throws(() => migrate({ files: { '/нет/такого.doc': { status: 'KEEP', reviewed_at: T1 } } }, manifest), /без документа/);
});

test('голоса: последний голос автора побеждает, снятый голос не воскресает', () => {
    const a = { votes: { 'Марина Олеговна': { status: 'KEEP', at: T1 } } };
    const b = { votes: { 'Марина Олеговна': { status: null, at: T2 }, 'Андрейченко Валерий': { status: 'KEEP', at: T1 } } };
    const merged = core.mergeEntries(a, b);
    assert.equal(merged.votes['Марина Олеговна'].status, null);
    assert.deepEqual(core.mergeEntries(b, a), merged);
    assert.equal(core.effectiveStatus(merged).status, 'KEEP');
});

test('итоговый статус: один голос, согласие, конфликт, решение арбитра', () => {
    assert.deepEqual(core.effectiveStatus({}), { status: null, resolved: false, conflict: false });
    assert.equal(core.effectiveStatus({ votes: { A: { status: 'DELETE', at: T1 } } }).status, 'DELETE');
    const conflict = { votes: { A: { status: 'DELETE', at: T1 }, B: { status: 'KEEP', at: T2 }, C: { status: 'DELETE', at: T2 } } };
    assert.deepEqual(core.effectiveStatus(conflict), { status: null, resolved: false, conflict: true });
    const resolved = core.mergeEntries(conflict, { resolution: { status: 'ARCHIVE', by: core.ARBITER, at: T3 } });
    assert.deepEqual(core.effectiveStatus(resolved), { status: 'ARCHIVE', resolved: true, conflict: false });
    assert.equal(Object.keys(resolved.votes).length, 3, 'голоса не затираются');
    const cleared = core.mergeEntries(resolved, { resolution: { status: null, by: core.ARBITER, at: '2026-09-12T00:00:00.000Z' } });
    assert.equal(core.effectiveStatus(cleared).conflict, true);
});

test('комментарии объединяются по id и сортируются по времени', () => {
    const first = { id: 'a', author: 'X', text: '<script>alert(1)</script>', created_at: T1 };
    const second = { id: 'b', author: 'Y', text: 'Нужно проверить', created_at: T2 };
    const merged = core.mergeEntries({ comments: [second] }, { comments: [first, second] });
    assert.deepEqual(merged.comments.map((c) => c.id), ['a', 'b']);
    assert.equal(merged.comments[0].text, first.text);
});

test('v1: решение без автора уходит на legacy-автора, отбор по путям', () => {
    const v1 = { version: 1, files: {
        '/a.doc': { name: 'a.doc', status: 'DELETE', reviewed_at: T1, reviewer: '' },
        '/b.doc': { name: 'b.doc', status: 'KEEP', reviewed_at: T2, reviewer: 'Марина Олеговна', comments: [{ id: 'c1', text: 'x', created_at: T2 }] },
        '/c.doc': { name: 'c.doc', status: null, reviewed_at: null, reviewer: '' }
    } };
    assert.ok(core.isV1(v1));
    assert.ok(!core.isV1({ version: 2, files: {} }));
    const ids = { '/a.doc': 'd_a', '/b.doc': 'd_b', '/c.doc': 'd_c' };
    const all = core.convertV1Envelope(v1, (p) => ids[p]);
    assert.equal(all.envelope.files.d_a.votes[core.LEGACY_AUTHOR].status, 'DELETE');
    assert.equal(all.envelope.files.d_b.votes['Марина Олеговна'].status, 'KEEP');
    assert.equal(all.envelope.files.d_b.comments.length, 1);
    assert.ok(!all.envelope.files.d_c, 'пустые записи экспорта v1 пропускаются');
    const only = core.convertV1Envelope(v1, (p) => ids[p], { paths: ['/b.doc'] });
    assert.deepEqual(Object.keys(only.envelope.files), ['d_b']);
    assert.deepEqual(core.convertV1Envelope(v1, () => null).unmatched.sort(), ['/a.doc', '/b.doc']);
});

test('конверт v2: нормализация, слияние, закрепления папок', () => {
    assert.deepEqual(core.normalizeEnvelope({ version: 1, files: { x: {} } }).files, {});
    const left = { version: 2, updated_at: T1, assignments: { '/Агент': { reviewers: ['A'], at: T1 } }, files: { d_1: { votes: { A: { status: 'KEEP', at: T1 } } } } };
    const right = { version: 2, updated_at: T2, assignments: { '/Агент': { reviewers: ['B', 'A'], at: T2 } }, files: { d_2: { comments: [{ id: 'z', created_at: T2 }] } } };
    const merged = core.mergeEnvelopes(left, right);
    assert.equal(merged.updated_at, T2);
    assert.deepEqual(merged.assignments['/Агент'].reviewers, ['A', 'B']);
    assert.deepEqual(Object.keys(merged.files), ['d_1', 'd_2']);
});

test('фильтр и поиск', () => {
    assert.equal(core.matchesFile('Договор.docx', '/Агент/Договор.docx', 'DELETE', 1, 'DELETE', 'договор'), true);
    assert.equal(core.matchesFile('Договор.docx', '/Агент/Договор.docx', 'DELETE', 1, 'KEEP', 'договор'), false);
    assert.equal(core.matchesFile('Договор.docx', '/Агент/Договор.docx', 'CONFLICT', 0, 'CONFLICT', ''), true);
    assert.equal(core.matchesFile('Договор.docx', '/Агент/Договор.docx', 'CONFLICT', 0, 'UNREVIEWED', ''), false);
    assert.equal(core.matchesFile('Договор.docx', '/Агент/Договор.docx', null, 0, 'COMMENTS', ''), false);
});

test('сканер: сопоставление по resource_id, пути и md5; пропавшие не удаляются', () => {
    const base = (id, p, rid, md5) => ({ id, name: path.basename(p), disk: { path: p, resource_id: rid, md5 }, history: { original_path: p, previous_paths: [] } });
    const docs = [base('d_1', '/a/x.doc', 'r1', 'm1'), base('d_2', '/a/y.doc', null, 'm2'), base('d_3', '/a/z.doc', null, 'm3'), base('d_4', '/a/gone.doc', 'r4', 'm4')];
    const file = (p, rid, md5) => ({ path: p, name: path.basename(p), resource_id: rid, md5, sha256: 's', size: 1 });
    const { documents, stats } = reconcile(docs, [
        file('/new/x.doc', 'r1', 'm1'),
        file('/a/y.doc', 'r2', 'm2'),
        file('/b/z-renamed.doc', 'r3', 'm3'),
        file('/a/fresh.doc', 'r5', 'm5')
    ], 'KEY', T3);
    const byId = Object.fromEntries(documents.map((d) => [d.id, d]));
    assert.equal(byId.d_1.disk.path, '/new/x.doc');
    assert.deepEqual(byId.d_1.history.previous_paths, ['/a/x.doc']);
    assert.equal(byId.d_3.disk.path, '/b/z-renamed.doc');
    assert.equal(byId.d_4.disk.missing_since, T3);
    assert.deepEqual(stats, { matched_resource: 1, matched_path: 1, matched_md5: 1, added: 1, missing: 1 });
});

test('страница: безопасный вывод, токен только в sessionStorage, данные в отдельном репозитории', () => {
    const source = readFileSync(path.join(root, 'review.js'), 'utf8');
    assert.ok(!source.includes('innerHTML'));
    assert.ok(source.includes('text.textContent = comment.text'));
    assert.ok(source.includes('sessionStorage.setItem(TOKEN_KEY'));
    assert.ok(!source.includes('localStorage.setItem(TOKEN_KEY'));
    assert.ok(source.includes("repository: 'FrDomianReview-data'"));
    assert.ok(!/\b657\b/.test(source), 'число файлов не должно быть зашито');
});

test('тип и размер файла', () => {
    assert.equal(core.fileType('MP4'), 'video');
    assert.equal(core.fileType('cdr'), 'layout');
    assert.equal(core.fileType('xyz'), 'other');
    assert.equal(core.formatSize(1536), '1,5 КБ');
    assert.equal(core.formatSize(3 * 1024 ** 3), '3,0 ГБ');
    assert.equal(core.matchesTypeAndSize('mp4', 200 * 1024 ** 2, 'video', 100 * 1024 ** 2), true);
    assert.equal(core.matchesTypeAndSize('mp4', 50 * 1024 ** 2, 'video', 100 * 1024 ** 2), false);
    assert.equal(core.matchesTypeAndSize('pdf', 50, 'video', 0), false);
    assert.equal(core.matchesTypeAndSize('pdf', null, 'ALL', 0), true);
});

test('отметка «Выполнено»: отдельно от голосов, авто-«Удалено» для пропавших файлов', () => {
    const entry = { votes: { A: { status: 'DELETE', at: T1 }, B: { status: 'DELETE', at: T1 } } };
    assert.equal(core.outcomeFor(entry, false), null);
    assert.deepEqual(core.outcomeFor(entry, true), { status: 'DELETED', auto: true, by: '', at: null });
    const done = core.mergeEntries(entry, { outcome: { status: 'DELETED', by: 'B', at: T2 } });
    assert.equal(core.effectiveStatus(done).status, 'DELETE', 'итог ревизии не меняется');
    assert.equal(core.outcomeFor(done, false).by, 'B');
    const undone = core.mergeEntries(done, { outcome: { status: null, by: 'A', at: T3 } });
    assert.equal(core.outcomeFor(undone, false), null);
    assert.equal(core.mergeEntries(undone, done).outcome.status, null, 'снятая отметка не воскресает');
    assert.equal(core.OUTCOME_FOR_STATUS.UPDATE, 'UPDATED');
    assert.equal(core.matchesFile('a', '/a', 'DELETE', 0, 'TODO', '', null), true);
    assert.equal(core.matchesFile('a', '/a', 'DELETE', 0, 'TODO', '', { status: 'DELETED' }), false);
    assert.equal(core.matchesFile('a', '/a', 'KEEP', 0, 'TODO', '', null), false);
    assert.equal(core.matchesFile('a', '/a', 'DELETE', 0, 'DONE', '', { status: 'DELETED' }), true);
});

test('пропавший с Диска файл: авто-«Удалено» сильнее ручного «Актуализировано»', () => {
    const updated = { votes: { A: { status: 'UPDATE', at: T1 } }, outcome: { status: 'UPDATED', by: 'A', at: T2 } };
    assert.equal(core.outcomeFor(updated, false).status, 'UPDATED');
    assert.deepEqual(core.outcomeFor(updated, true), { status: 'DELETED', auto: true, by: '', at: null });
    const deleted = { votes: { A: { status: 'DELETE', at: T1 } }, outcome: { status: 'DELETED', by: 'B', at: T2 } };
    assert.deepEqual(core.outcomeFor(deleted, true), { status: 'DELETED', auto: false, by: 'B', at: T2 },
        'ручное «Удалено» сохраняет автора и дату');
});

test('«Выполнено» — только если отметка соответствует решению', () => {
    const deleted = { status: 'DELETED' };
    const updated = { status: 'UPDATED' };
    assert.equal(core.completionOf('DELETE', deleted).state, 'done');
    assert.equal(core.completionOf('DUPLICATE', deleted).state, 'done');
    assert.equal(core.completionOf('UPDATE', updated).state, 'done');
    assert.deepEqual(core.completionOf('UPDATE', deleted), { state: 'todo', expected: 'UPDATED', mismatch: true });
    assert.deepEqual(core.completionOf('DELETE', updated), { state: 'todo', expected: 'DELETED', mismatch: true });
    assert.deepEqual(core.completionOf('KEEP', deleted), { state: 'mismatch', expected: null, mismatch: true });
    assert.deepEqual(core.completionOf('CONFLICT', updated), { state: 'mismatch', expected: null, mismatch: true });
    assert.equal(core.completionOf(null, deleted).mismatch, false, 'непроверенный пропавший файл — без предупреждения');
    assert.equal(core.completionOf('KEEP', null).state, null);

    assert.equal(core.matchesFile('a', '/a', 'UPDATE', 0, 'DONE', '', deleted), false);
    assert.equal(core.matchesFile('a', '/a', 'UPDATE', 0, 'TODO', '', deleted), true);
    assert.equal(core.matchesFile('a', '/a', 'KEEP', 0, 'DONE', '', deleted), false);
    assert.equal(core.matchesFile('a', '/a', 'KEEP', 0, 'TODO', '', deleted), false);
});

test('план удаления v2: DELETE и DUPLICATE по голосам и арбитру, выполненные и конфликты исключены', () => {
    const doc = (id, missing) => ({ id, name: `${id}.docx`, disk: { path: `/Папка/${id}.docx`, size: 10, viewer_url: `v/${id}`, missing_since: missing ? T1 : null } });
    const manifest = { documents: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((id) => doc(id, id === 'c')) };
    const decisions = {
        version: 2,
        files: {
            a: { votes: { A: { status: 'DELETE', at: T1 }, B: { status: 'DELETE', at: T2 } } },
            b: { votes: { A: { status: 'DELETE', at: T1 }, B: { status: 'KEEP', at: T1 } } },
            c: { votes: { A: { status: 'DELETE', at: T1 } } },
            d: { votes: { A: { status: 'DELETE', at: T1 } }, outcome: { status: 'DELETED', by: 'A', at: T2 } },
            e: { votes: { A: { status: 'KEEP', at: T1 }, B: { status: 'DELETE', at: T1 } },
                resolution: { status: 'DELETE', by: core.ARBITER, at: T3 } },
            f: { votes: { A: { status: 'DELETE', at: T1 } }, resolution: { status: 'KEEP', by: core.ARBITER, at: T2 } },
            g: { votes: { A: { status: 'DELETE', at: T1 }, B: { status: null, at: T2 } } },
            h: { votes: { A: { status: 'DUPLICATE', at: T1 }, B: { status: 'DUPLICATE', at: T2 } } },
            i: { votes: { A: { status: 'DUPLICATE', at: T1 } }, outcome: { status: 'DELETED', by: 'A', at: T2 } }
        }
    };
    const { plan, done, conflicts } = buildDeletePlan(manifest, decisions);
    assert.deepEqual(plan.map((row) => row.id), ['a', 'e', 'g', 'h']);
    assert.deepEqual(plan.map((row) => row.decision_status), ['DELETE', 'DELETE', 'DELETE', 'DUPLICATE']);
    assert.equal(plan[0].decided_by, 'A, B');
    assert.equal(plan[0].decided_at, T2);
    assert.equal(plan[1].decided_by, core.ARBITER);
    assert.equal(plan[1].resolved_by_arbiter, true);
    assert.equal(plan[3].decided_by, 'A, B');
    assert.equal(done, 3, 'c — файла нет на Диске, d и i — отмечены «Удалено»');
    assert.equal(conflicts, 1, 'b — конфликт без арбитра');
    assert.match(toCsv(plan).split('\n')[0], /^"id","decision_status","path","name"/);

    assert.throws(() => buildDeletePlan(manifest, { files: { '/Папка/a.docx': { status: 'DELETE' } } }), /v1/);
    assert.throws(() => buildDeletePlan(manifest, { version: 2, files: { zzz: { votes: { A: { status: 'DELETE', at: T1 } } } } }), /zzz/);
});

test('карантин: по журналу видно, что сейчас в карантине', () => {
    const log = [
        { id: 'd_1', action: 'quarantine', result: 'ok', from: '/a', to: '/q/a' },
        { id: 'd_2', action: 'quarantine', result: 'ok', from: '/b', to: '/q/b' },
        { id: 'd_3', action: 'quarantine', result: 'failed', from: '/c', to: '/q/c' },
        { id: 'd_2', action: 'restore', result: 'ok', from: '/q/b', to: '/b' },
        { id: 'd_1', action: 'restore', result: 'skipped', from: '/q/a', to: '/a' }
    ];
    assert.deepEqual(quarantined(log).map((entry) => entry.id), ['d_1']);
});
