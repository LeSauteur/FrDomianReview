const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'review.js'), 'utf8');
vm.runInThisContext(source, { filename: 'review.js' });
const review = globalThis.FrDomianReviewTest;

const index = JSON.parse(fs.readFileSync(path.join(root, 'data/yandex-disk-index.json'), 'utf8'));
const files = index.filter((entry) => entry.type === 'file');
const folders = index.filter((entry) => entry.type === 'dir');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

assert.equal(files.length, 657);
assert.equal(folders.length, 135);
assert.equal((html.match(/<li class="file-row"/g) || []).length, 657);
assert.equal((html.match(/<li class="folder"/g) || []).length, 135);
assert.equal((html.match(/class="comments-area"/g) || []).length, 657);
assert.equal((html.match(/<a class="file-name" href="https:\/\/docs\.yandex\.ru\/docs\/view\?/g) || []).length, 657);
assert.equal((html.match(/<button type="button" data-status="(?:KEEP|ARCHIVE|UPDATE|DUPLICATE|DELETE|UNSURE)"/g) || []).length, 657 * 6);
assert.equal(review.REVIEWERS.length, 3);

const older = '2026-09-11T10:00:00.000Z';
const newer = '2026-09-11T11:00:00.000Z';
const firstComment = { id: 'a', author: 'Егупов Алексей', text: '<script>alert(1)</script>', created_at: older };
const secondComment = { id: 'b', author: 'Марина Олеговна', text: 'Нужно проверить', created_at: newer };

const oldDecision = review.normalizeDecision({
    name: 'file.docx', status: 'KEEP', reviewed_at: older, reviewer: 'Егупов Алексей'
});
assert.deepEqual(oldDecision.comments, []);

const merged = review.mergeDecisionFiles({
    '/file.docx': { ...oldDecision, comments: [firstComment] }
}, {
    '/file.docx': {
        name: 'file.docx', status: 'DELETE', reviewed_at: newer,
        reviewer: 'Андрейченко Валерий', comments: [secondComment, firstComment]
    }
})['/file.docx'];
assert.equal(merged.status, 'DELETE');
assert.equal(merged.reviewer, 'Андрейченко Валерий');
assert.deepEqual(merged.comments.map((comment) => comment.id), ['a', 'b']);
assert.equal(merged.comments[0].text, '<script>alert(1)</script>');

const reverseMerge = review.mergeDecisionFiles({
    '/file.docx': { status: 'UNSURE', reviewed_at: newer, comments: [firstComment] }
}, {
    '/file.docx': { status: 'KEEP', reviewed_at: older, comments: [secondComment] }
})['/file.docx'];
assert.equal(reverseMerge.status, 'UNSURE');
assert.deepEqual(reverseMerge.comments.map((comment) => comment.id), ['a', 'b']);

assert.equal(review.matchesFile('Договор.docx', '/Агент/Договор.docx', 'DELETE', 1, 'DELETE', 'договор'), true);
assert.equal(review.matchesFile('Договор.docx', '/Агент/Договор.docx', 'DELETE', 1, 'KEEP', 'договор'), false);
assert.equal(review.matchesFile('Договор.docx', '/Агент/Договор.docx', 'DELETE', 1, 'COMMENTS', 'агент'), true);
assert.equal(review.matchesFile('Договор.docx', '/Агент/Договор.docx', null, 0, 'UNREVIEWED', 'агент'), true);
assert.equal(review.matchesFile('Договор.docx', '/Агент/Договор.docx', null, 0, 'COMMENTS', ''), false);

assert.ok(source.includes('text.textContent = comment.text'));
assert.ok(!source.includes('innerHTML'));
assert.ok(source.includes('comments: normalizeComments(decision && decision.comments)'));
assert.ok(source.includes('mergeComments(base.comments, incoming.comments)'));
assert.ok(source.includes('sessionStorage.setItem(TOKEN_KEY'));
assert.ok(!source.includes('localStorage.setItem(TOKEN_KEY'));

console.log('PASS: index, tree, comment merge, search/filter, export/import hooks, safe comment rendering');
