(function () {
    'use strict';

    const core = globalThis.FrDomianCore;
    const CONFIG = {
        // Решения ревизии хранятся в отдельном приватном репозитории: токен проверяющего
        // даёт доступ только к нему и не позволяет менять код инструмента.
        owner: 'LeSauteur',
        repository: 'FrDomianReview-data',
        branch: 'main',
        decisionsPath: 'review-decisions.json',
        manifestUrl: 'data/manifest.json',
        apiVersion: '2022-11-28'
    };
    const { STATUSES, REVIEWERS, ARBITER } = core;
    const STATUS_LABELS = {
        KEEP: 'Оставить',
        ARCHIVE: 'Архив',
        UPDATE: 'Обновить',
        DUPLICATE: 'Дубликат',
        DELETE: 'Удалить',
        UNSURE: 'Не уверен'
    };
    const OUTCOME_LABELS = { DELETED: 'Удалено', UPDATED: 'Актуализировано' };
    const CACHE_KEY = 'frdomian-review.cache.v2';
    const LEGACY_CACHE_KEY = 'frdomian-review.cache.v1';
    const REVIEWER_KEY = 'frdomian-review.reviewer.v1';
    const TOKEN_KEY = 'frdomian-review.github-token.v2';
    const DRAFT_PREFIX = 'frdomian-review.comment-draft.v2:';
    const LEGACY_DRAFT_PREFIX = 'frdomian-review.comment-draft.v1:';

    const state = {
        manifest: null,
        docs: [],
        docsById: new Map(),
        pathIndex: new Map(),
        rowsById: new Map(),
        decisions: core.emptyEnvelope(),
        dirtyIds: new Set(),
        currentFilter: 'ALL',
        searchTerm: '',
        typeFilter: 'ALL',
        minSize: 0,
        viewMode: 'tree',
        lastSyncedAt: null,
        syncing: false,
        autosaveStopped: false,
        changesSinceSync: 0
    };

    const elements = {};

    class GitHubHttpError extends Error {
        constructor(status) {
            super(`GitHub API returned HTTP ${status}`);
            this.name = 'GitHubHttpError';
            this.status = status;
        }
    }

    // ---- локальный кэш ----

    function storageAvailable() {
        const testKey = `${CACHE_KEY}.test`;
        try {
            localStorage.setItem(testKey, '1');
            const works = localStorage.getItem(testKey) === '1';
            localStorage.removeItem(testKey);
            return works;
        } catch (error) {
            return false;
        }
    }

    function loadLocalCache() {
        if (!storageAvailable()) {
            return { envelope: core.emptyEnvelope(), dirtyIds: [] };
        }
        try {
            const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
            return {
                envelope: core.normalizeEnvelope(parsed),
                dirtyIds: Array.isArray(parsed.dirty_ids) ? parsed.dirty_ids.filter((id) => typeof id === 'string') : []
            };
        } catch (error) {
            return { envelope: core.emptyEnvelope(), dirtyIds: [] };
        }
    }

    function saveLocalCache() {
        if (!storageAvailable()) {
            setSyncState('error', 'Локальное сохранение недоступно');
            return false;
        }
        localStorage.setItem(CACHE_KEY, JSON.stringify({ ...state.decisions, dirty_ids: Array.from(state.dirtyIds) }));
        return true;
    }

    // Несохранённые изменения из кэша прежней версии (v1, ключ — путь) переносятся в v2.
    // Ключ v1 не изменяется: перенос идемпотентен и повторяется при каждой загрузке,
    // поэтому правки из ещё открытой старой вкладки тоже не потеряются.
    function importLegacyCache() {
        let parsed;
        try {
            parsed = JSON.parse(localStorage.getItem(LEGACY_CACHE_KEY) || 'null');
        } catch (error) {
            return { moved: 0, unmatched: 0 };
        }
        if (!parsed || !Array.isArray(parsed.dirty_paths) || parsed.dirty_paths.length === 0) {
            return { moved: 0, unmatched: 0 };
        }
        const { envelope, unmatched } = core.convertV1Envelope(
            parsed, (path) => state.pathIndex.get(path) || null, { paths: parsed.dirty_paths }
        );
        let moved = 0;
        Object.entries(envelope.files).forEach(([id, entry]) => {
            if (mergeIntoLocal(id, entry)) {
                moved += 1;
            }
        });
        return { moved, unmatched: unmatched.length };
    }

    function mergeIntoLocal(id, entry) {
        const before = JSON.stringify(core.normalizeEntry(state.decisions.files[id]));
        const merged = core.mergeEntries(state.decisions.files[id], entry);
        if (JSON.stringify(merged) === before) {
            return false;
        }
        state.decisions.files[id] = merged;
        state.dirtyIds.add(id);
        return true;
    }

    // ---- GitHub ----

    function githubApiUrl() {
        const encodedPath = CONFIG.decisionsPath.split('/').map(encodeURIComponent).join('/');
        return `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repository}/contents/${encodedPath}?ref=${encodeURIComponent(CONFIG.branch)}`;
    }

    function githubHeaders(token, includeJson) {
        const headers = {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': CONFIG.apiVersion,
            Authorization: `Bearer ${token}`
        };
        if (includeJson) {
            headers['Content-Type'] = 'application/json';
        }
        return headers;
    }

    function decodeBase64Utf8(value) {
        const binary = atob(String(value || '').replace(/\s/g, ''));
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    }

    function encodeBase64Utf8(value) {
        const bytes = new TextEncoder().encode(value);
        let binary = '';
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
        }
        return btoa(binary);
    }

    async function readGitHubDecisions(token) {
        const response = await fetch(githubApiUrl(), {
            method: 'GET',
            headers: githubHeaders(token, false),
            cache: 'no-store'
        });
        if (!response.ok) {
            throw new GitHubHttpError(response.status);
        }
        const metadata = await response.json();
        const parsed = JSON.parse(decodeBase64Utf8(metadata.content));
        if (!parsed || parsed.version !== 2) {
            throw new Error('В репозитории данных не файл формата v2');
        }
        return { sha: metadata.sha, envelope: core.normalizeEnvelope(parsed) };
    }

    async function putGitHubDecisions(token, sha, envelope) {
        const response = await fetch(githubApiUrl(), {
            method: 'PUT',
            headers: githubHeaders(token, true),
            body: JSON.stringify({
                message: 'Update review decisions',
                content: encodeBase64Utf8(`${JSON.stringify(envelope, null, 2)}\n`),
                sha,
                branch: CONFIG.branch
            })
        });
        if (!response.ok) {
            throw new GitHubHttpError(response.status);
        }
        return response.json();
    }

    function syncErrorText(error) {
        if (error instanceof GitHubHttpError) {
            if (error.status === 401) return 'токен недействителен';
            if (error.status === 403 || error.status === 404) return `нет доступа к ${CONFIG.repository} (HTTP ${error.status})`;
            return `HTTP ${error.status}`;
        }
        return error.message;
    }

    // ---- UI-состояние ----

    function setSyncState(kind, text) {
        elements.syncState.dataset.state = kind;
        elements.syncState.textContent = text;
    }

    function formatDate(value) {
        if (!value) {
            return '';
        }
        const parsed = new Date(value);
        return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString('ru-RU');
    }

    function updateLastSync() {
        elements.lastSync.textContent = `Последняя синхронизация: ${formatDate(state.lastSyncedAt) || 'ещё не выполнялась'}`;
    }

    function getToken() {
        try {
            return sessionStorage.getItem(TOKEN_KEY) || '';
        } catch (error) {
            return '';
        }
    }

    function setToken(value) {
        try {
            if (value) {
                sessionStorage.setItem(TOKEN_KEY, value);
            } else {
                sessionStorage.removeItem(TOKEN_KEY);
            }
        } catch (error) {
            setSyncState('error', 'sessionStorage недоступен');
        }
    }

    function getReviewer() {
        return REVIEWERS.includes(elements.reviewer.value) ? elements.reviewer.value : '';
    }

    function isArbiter() {
        return getReviewer() === ARBITER;
    }

    function loadReviewer() {
        try {
            const saved = localStorage.getItem(REVIEWER_KEY) || '';
            elements.reviewer.value = REVIEWERS.includes(saved) ? saved : '';
        } catch (error) {
            elements.reviewer.value = '';
        }
    }

    function saveReviewer() {
        try {
            localStorage.setItem(REVIEWER_KEY, getReviewer());
        } catch (error) {
            setSyncState('error', 'Не удалось сохранить имя проверяющего');
        }
        applyAllDecisions();
    }

    function draftKey(id) {
        return `${DRAFT_PREFIX}${id}`;
    }

    function loadDraft(row) {
        try {
            return localStorage.getItem(draftKey(row.dataset.id))
                || localStorage.getItem(`${LEGACY_DRAFT_PREFIX}${encodeURIComponent(row.dataset.path)}`)
                || '';
        } catch (error) {
            return '';
        }
    }

    function saveDraft(row, text) {
        try {
            localStorage.setItem(draftKey(row.dataset.id), text);
        } catch (error) {
            setSyncState('error', 'Не удалось сохранить черновик локально');
        }
    }

    function clearDraft(row) {
        try {
            localStorage.removeItem(draftKey(row.dataset.id));
            localStorage.removeItem(`${LEGACY_DRAFT_PREFIX}${encodeURIComponent(row.dataset.path)}`);
        } catch (error) {
            setSyncState('error', 'Не удалось очистить черновик');
        }
    }

    function entryFor(id) {
        return core.normalizeEntry(state.decisions.files[id]);
    }

    function outcomeOf(id) {
        const doc = state.docsById.get(id);
        return core.outcomeFor(state.decisions.files[id], Boolean(doc && doc.disk.missing_since));
    }

    function rowStatus(id) {
        const effective = core.effectiveStatus(state.decisions.files[id]);
        return effective.conflict ? 'CONFLICT' : effective.status;
    }

    // ---- дерево ----

    function createElement(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function buildFolderTree() {
        const root = { name: state.manifest.source.root_name || 'Каталог', path: '/', depth: 0, folders: new Map(), files: [] };
        state.docs.forEach((doc) => {
            const parts = doc.disk.path.split('/').filter(Boolean);
            let node = root;
            parts.slice(0, -1).forEach((part) => {
                if (!node.folders.has(part)) {
                    node.folders.set(part, {
                        name: part,
                        path: `${node.path === '/' ? '' : node.path}/${part}`,
                        depth: node.depth + 1,
                        folders: new Map(),
                        files: []
                    });
                }
                node = node.folders.get(part);
            });
            node.files.push(doc);
        });
        return root;
    }

    function renderFileRow(doc) {
        const row = createElement('li', 'file-row');
        row.dataset.id = doc.id;
        row.dataset.path = doc.disk.path;
        row.dataset.name = doc.name;
        row.dataset.extension = doc.ext;
        const missing = Boolean(doc.disk.missing_since);
        row.classList.toggle('missing', missing);

        const heading = createElement('div', 'file-heading');
        const title = missing ? createElement('span', 'file-name', doc.name) : createElement('a', 'file-name', doc.name);
        if (!missing) {
            title.href = doc.disk.viewer_url;
            title.target = '_blank';
            title.rel = 'noopener noreferrer';
        }
        const meta = createElement('span', 'file-meta',
            [doc.ext, core.formatSize(doc.disk.size), formatDate(doc.disk.modified)].filter(Boolean).join(' · '));
        heading.append(title, meta);
        if (state.viewMode !== 'tree') {
            heading.append(createElement('span', 'file-folder', doc.disk.path.slice(0, doc.disk.path.lastIndexOf('/')) || '/'));
        }
        if (missing) {
            heading.append(createElement('span', 'missing-badge', `нет на Диске с ${formatDate(doc.disk.missing_since)}`));
        }

        const actions = createElement('div', 'file-actions');
        const open = createElement('a', 'open-link', 'Открыть');
        if (missing) {
            open.setAttribute('aria-disabled', 'true');
        } else {
            open.href = doc.disk.viewer_url;
            open.target = '_blank';
            open.rel = 'noopener noreferrer';
        }
        actions.append(open);
        STATUSES.forEach((status) => {
            const button = createElement('button', '', STATUS_LABELS[status]);
            button.type = 'button';
            button.dataset.status = status;
            actions.append(button);
        });

        row.append(heading, actions, createElement('div', 'outcome-area'), createElement('div', 'votes-area'), createElement('div', 'comments-area'));
        state.rowsById.set(doc.id, row);
        return row;
    }

    function renderFolder(node) {
        const item = createElement('li', 'folder');
        item.dataset.depth = String(node.depth);
        item.dataset.path = node.path;
        const line = createElement('div', 'folder-line');
        const toggle = createElement('button', 'folder-toggle', '−');
        toggle.type = 'button';
        toggle.setAttribute('aria-expanded', 'true');
        line.append(toggle, createElement('span', '', node.name));
        const list = createElement('ul');
        const byName = (left, right) => left.name.localeCompare(right.name, 'ru');
        node.files.slice().sort(byName).forEach((doc) => list.append(renderFileRow(doc)));
        Array.from(node.folders.values()).sort(byName).forEach((child) => list.append(renderFolder(child)));
        item.append(line, list);
        return item;
    }

    // Вид «По папкам» — дерево; «Список по размеру» — все файлы одним списком, сначала самые тяжёлые.
    function renderCatalog() {
        state.rowsById = new Map();
        if (state.viewMode === 'tree') {
            elements.catalog.classList.remove('flat');
            elements.catalog.replaceChildren(renderFolder(buildFolderTree()));
        } else {
            elements.catalog.classList.add('flat');
            const sizeOf = (doc) => (typeof doc.disk.size === 'number' ? doc.disk.size : -1);
            const docs = state.docs.slice().sort((left, right) => sizeOf(right) - sizeOf(left)
                || left.disk.path.localeCompare(right.disk.path, 'ru'));
            elements.catalog.replaceChildren(...docs.map(renderFileRow));
        }
        elements.folders = Array.from(elements.catalog.querySelectorAll('.folder'))
            .sort((left, right) => Number(right.dataset.depth) - Number(left.dataset.depth));
    }

    function fillTypeFilter() {
        const counts = new Map();
        state.docs.forEach((doc) => {
            const type = core.fileType(doc.ext);
            counts.set(type, (counts.get(type) || 0) + 1);
        });
        const types = [...core.FILE_TYPES.map(([type, label]) => [type, label]), ['other', 'Прочее']];
        types.forEach(([type, label]) => {
            if (counts.get(type)) {
                elements.typeFilter.append(new Option(`${label} (${counts.get(type)})`, type));
            }
        });
    }

    // ---- строка файла ----

    function renderVotes(row) {
        const area = row.querySelector('.votes-area');
        const entry = entryFor(row.dataset.id);
        const effective = core.effectiveStatus(entry);
        area.replaceChildren();
        const votes = Object.entries(entry.votes).filter(([, vote]) => vote.status);
        const resolution = entry.resolution && entry.resolution.status ? entry.resolution : null;

        if (votes.length) {
            const line = createElement('div', 'votes-line');
            if (effective.conflict && !resolution) {
                line.append(createElement('span', 'conflict-badge', 'Конфликт'));
            }
            line.append(createElement('span', 'votes-label', 'Голоса:'));
            votes.forEach(([name, vote]) => {
                const item = createElement('span', 'vote');
                item.dataset.status = vote.status;
                item.title = formatDate(vote.at);
                item.textContent = `${name} — ${STATUS_LABELS[vote.status]}`;
                line.append(item);
            });
            area.append(line);
        }
        if (resolution) {
            area.append(createElement('div', 'resolution-line',
                `Решение арбитра: ${STATUS_LABELS[resolution.status]} (${resolution.by}, ${formatDate(resolution.at)})`));
        }
        if (isArbiter() && (effective.conflict || resolution)) {
            const label = createElement('label', 'resolution-control', 'Решение арбитра ');
            const select = createElement('select', 'resolution-select');
            select.append(new Option('— не принято —', ''));
            STATUSES.forEach((status) => select.append(new Option(STATUS_LABELS[status], status)));
            select.value = resolution ? resolution.status : '';
            label.append(select);
            area.append(label);
        }
    }

    function renderOutcome(row) {
        const area = row.querySelector('.outcome-area');
        const id = row.dataset.id;
        const outcome = outcomeOf(id);
        const status = rowStatus(id);
        area.replaceChildren();
        if (outcome) {
            const who = outcome.auto ? 'файла нет на Диске' : `${outcome.by}, ${formatDate(outcome.at)}`;
            const badge = createElement('span', 'outcome-badge', `✓ ${OUTCOME_LABELS[outcome.status]} (${who})`);
            badge.dataset.outcome = outcome.status;
            area.append(badge);
            if (core.completionOf(status, outcome).mismatch) {
                const label = status === 'CONFLICT' ? 'конфликт' : `«${STATUS_LABELS[status]}»`;
                area.append(createElement('span', 'outcome-warning', `не совпадает с итогом ревизии — ${label}`));
            }
            if (!outcome.auto) {
                area.append(commentButton('clear-outcome', 'Снять отметку'));
            }
            return;
        }
        const suggested = core.OUTCOME_FOR_STATUS[status];
        if (suggested) {
            const button = commentButton('mark-outcome', `✓ Отметить: ${OUTCOME_LABELS[suggested]}`);
            button.dataset.outcome = suggested;
            area.append(button);
        }
    }

    function renderComments(row) {
        const area = row.querySelector('.comments-area');
        const comments = entryFor(row.dataset.id).comments;
        const mode = row.dataset.commentMode || 'preview';
        area.replaceChildren();

        if (comments.length > 0) {
            const summary = createElement('div', 'comment-summary');
            summary.append(createElement('span', 'comment-count', `Комментарии: ${comments.length}`), commentButton('add-comment', 'Добавить комментарий'));
            area.append(summary);

            const shown = mode === 'all' ? comments
                : mode === 'recent' ? comments.slice(-3)
                    : comments.slice(-1);
            const list = createElement('div', 'comment-list');
            shown.forEach((comment) => {
                const item = createElement('div', 'comment-item');
                const heading = createElement('div', 'comment-heading');
                const date = createElement('time', 'comment-date', formatDate(comment.created_at));
                date.dateTime = comment.created_at;
                heading.append(createElement('strong', 'comment-author', comment.author || 'Автор не указан'), date);
                const text = createElement('p', 'comment-text');
                text.textContent = comment.text;
                item.append(heading, text);
                list.append(item);
            });
            area.append(list);

            if (comments.length > 1) {
                let label = 'Скрыть историю';
                if (mode === 'preview') {
                    label = comments.length > 3 ? 'Показать последние 3' : `Показать все (${comments.length})`;
                } else if (mode === 'recent' && comments.length > 3) {
                    label = `Показать все (${comments.length})`;
                }
                area.append(commentButton('show-comments', label));
            }
        } else {
            area.append(commentButton('add-comment', 'Комментарий'));
        }

        if (row.dataset.editorOpen === 'true') {
            const editor = createElement('div', 'comment-editor');
            const textarea = createElement('textarea', 'comment-draft');
            textarea.rows = 3;
            textarea.placeholder = 'Комментарий по файлу…';
            textarea.value = loadDraft(row);
            const actions = createElement('div', 'comment-editor-actions');
            actions.append(commentButton('save-comment', 'Сохранить комментарий'), commentButton('cancel-comment', 'Отмена'));
            editor.append(createElement('div', 'comment-author-selected', getReviewer() || 'Выберите проверяющего в верхней панели'), textarea, actions);
            area.append(editor);
        }
    }

    function commentButton(className, label) {
        const button = createElement('button', className, label);
        button.type = 'button';
        return button;
    }

    function applyDecisionToRow(row) {
        const status = rowStatus(row.dataset.id);
        row.dataset.status = status || '';
        row.classList.toggle('reviewed', Boolean(status));
        const outcome = outcomeOf(row.dataset.id);
        row.dataset.outcome = outcome ? outcome.status : '';
        const reviewer = getReviewer();
        const myVote = reviewer && entryFor(row.dataset.id).votes[reviewer];
        const mine = myVote ? myVote.status : null;
        row.querySelectorAll('.file-actions button[data-status]').forEach((button) => {
            const selected = button.dataset.status === mine;
            button.classList.toggle('selected', selected);
            button.setAttribute('aria-pressed', String(selected));
        });
        renderOutcome(row);
        renderVotes(row);
        renderComments(row);
    }

    function applyAllDecisions() {
        state.rowsById.forEach((row) => applyDecisionToRow(row));
        updateCounters();
        applyFilter();
    }

    function updateCounters() {
        const counts = Object.fromEntries([...STATUSES, 'CONFLICT', 'TODO', 'DONE'].map((status) => [status, 0]));
        let reviewed = 0;
        state.docs.forEach((doc) => {
            const status = rowStatus(doc.id);
            const outcome = outcomeOf(doc.id);
            if (status) {
                counts[status] += 1;
                reviewed += 1;
            }
            const completion = core.completionOf(status, outcome).state;
            if (completion === 'done') {
                counts.DONE += 1;
            } else if (completion === 'todo') {
                counts.TODO += 1;
            }
        });
        const total = state.docs.length;
        const percent = total ? (reviewed * 100 / total).toLocaleString('ru-RU', {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1
        }) : '0,0';
        elements.countTotal.textContent = String(total);
        elements.countReviewed.textContent = String(reviewed);
        elements.countUnreviewed.textContent = String(total - reviewed);
        elements.progress.textContent = `${reviewed} / ${total} — ${percent}%`;
        Object.keys(counts).forEach((status) => {
            elements[`count${status}`].textContent = String(counts[status]);
        });
    }

    function applyFilter() {
        let shown = 0;
        let shownSize = 0;
        state.rowsById.forEach((row, id) => {
            const doc = state.docsById.get(id);
            row.hidden = !core.matchesFile(row.dataset.name, row.dataset.path, rowStatus(id),
                entryFor(id).comments.length, state.currentFilter, state.searchTerm, outcomeOf(id))
                || !core.matchesTypeAndSize(doc.ext, doc.disk.size, state.typeFilter, state.minSize);
            if (!row.hidden) {
                shown += 1;
                shownSize += typeof doc.disk.size === 'number' ? doc.disk.size : 0;
            }
        });
        elements.shownSummary.textContent = `Показано: ${shown} · ${core.formatSize(shownSize)}`;
        (elements.folders || []).forEach((folder) => {
            folder.hidden = !folder.querySelector('.file-row:not([hidden])');
        });
        elements.filterButtons.forEach((button) => {
            button.classList.toggle('active-filter', button.dataset.filter === state.currentFilter);
        });
    }

    // ---- изменения ----

    function requireReviewer() {
        const reviewer = getReviewer();
        if (!reviewer) {
            elements.message.textContent = 'Сначала выберите проверяющего.';
            elements.reviewer.focus();
        }
        return reviewer;
    }

    function changeEntry(row, mutate) {
        const id = row.dataset.id;
        const entry = entryFor(id);
        mutate(entry);
        state.decisions.files[id] = entry;
        state.dirtyIds.add(id);
        state.changesSinceSync += 1;
        state.decisions.updated_at = new Date().toISOString();
        saveLocalCache();
        applyDecisionToRow(row);
        updateCounters();
        applyFilter();
        setSyncState('dirty', 'Есть несохранённые изменения');
    }

    function chooseStatus(row, requestedStatus) {
        const reviewer = requireReviewer();
        if (!reviewer) return;
        changeEntry(row, (entry) => {
            const current = entry.votes[reviewer] ? entry.votes[reviewer].status : null;
            entry.votes[reviewer] = {
                status: current === requestedStatus ? null : requestedStatus,
                at: new Date().toISOString()
            };
        });
        if (state.changesSinceSync >= 10 && !state.autosaveStopped) {
            syncOnline();
        }
    }

    function setResolution(row, status) {
        if (!isArbiter()) return;
        changeEntry(row, (entry) => {
            entry.resolution = { status: core.normalizeStatus(status), by: ARBITER, at: new Date().toISOString() };
        });
        if (!state.autosaveStopped) {
            syncOnline();
        }
    }

    function setOutcome(row, status) {
        const reviewer = requireReviewer();
        if (!reviewer) return;
        changeEntry(row, (entry) => {
            entry.outcome = { status, by: reviewer, at: new Date().toISOString() };
        });
        if (!state.autosaveStopped) {
            syncOnline();
        }
    }

    function addComment(row) {
        const reviewer = requireReviewer();
        if (!reviewer) return;
        const textarea = row.querySelector('.comment-draft');
        const text = textarea ? textarea.value.trim() : '';
        if (!text) {
            elements.message.textContent = 'Введите текст комментария.';
            if (textarea) textarea.focus();
            return;
        }
        row.dataset.editorOpen = 'false';
        changeEntry(row, (entry) => {
            entry.comments = core.mergeComments(entry.comments, [{
                id: crypto.randomUUID(),
                author: reviewer,
                text,
                created_at: new Date().toISOString()
            }]);
        });
        clearDraft(row);
        elements.message.textContent = 'Комментарий сохранён локально.';
        if (!state.autosaveStopped) {
            syncOnline();
        }
    }

    // ---- синхронизация ----

    async function syncOnline() {
        if (state.syncing || state.dirtyIds.size === 0 || state.autosaveStopped) {
            return;
        }
        const token = getToken();
        if (!token) {
            setSyncState('dirty', 'Есть несохранённые изменения — введите GitHub token');
            return;
        }

        state.syncing = true;
        const dirtyAtStart = new Map(Array.from(state.dirtyIds, (id) => [id, JSON.stringify(state.decisions.files[id])]));
        setSyncState('dirty', 'Синхронизация…');
        try {
            let remote = await readGitHubDecisions(token);
            let merged = core.mergeEnvelopes(remote.envelope, state.decisions);
            merged.updated_at = new Date().toISOString();
            try {
                await putGitHubDecisions(token, remote.sha, merged);
            } catch (error) {
                if (!(error instanceof GitHubHttpError) || error.status !== 409) {
                    throw error;
                }
                remote = await readGitHubDecisions(token);
                merged = core.mergeEnvelopes(remote.envelope, merged);
                merged.updated_at = new Date().toISOString();
                await putGitHubDecisions(token, remote.sha, merged);
            }

            const pendingIds = new Set();
            state.dirtyIds.forEach((id) => {
                if (!dirtyAtStart.has(id) || JSON.stringify(state.decisions.files[id]) !== dirtyAtStart.get(id)) {
                    pendingIds.add(id);
                }
            });
            state.decisions = core.mergeEnvelopes(merged, state.decisions);
            state.dirtyIds = pendingIds;
            state.changesSinceSync = pendingIds.size;
            state.autosaveStopped = false;
            state.lastSyncedAt = merged.updated_at;
            saveLocalCache();
            applyAllDecisions();
            updateLastSync();
            setSyncState(pendingIds.size ? 'dirty' : 'saved', pendingIds.size ? 'Есть несохранённые изменения' : 'Сохранено онлайн');
        } catch (error) {
            state.autosaveStopped = true;
            setSyncState('error', `Ошибка синхронизации: ${syncErrorText(error)}`);
        } finally {
            state.syncing = false;
        }
    }

    async function loadRemoteDecisions() {
        const token = getToken();
        if (!token) {
            setSyncState('dirty', 'Работа локально — введите GitHub token, чтобы видеть общие решения');
            return;
        }
        try {
            const remote = await readGitHubDecisions(token);
            state.decisions = core.mergeEnvelopes(remote.envelope, state.decisions);
            state.lastSyncedAt = remote.envelope.updated_at;
            saveLocalCache();
            applyAllDecisions();
            updateLastSync();
            setSyncState(state.dirtyIds.size ? 'dirty' : 'saved',
                state.dirtyIds.size ? 'Есть несохранённые изменения' : 'Онлайн-решения загружены');
            if (state.dirtyIds.size) {
                syncOnline();
            }
        } catch (error) {
            setSyncState('error', `Онлайн недоступен: ${syncErrorText(error)} — используется локальная копия`);
        }
    }

    // ---- экспорт / импорт ----

    function exportBackup() {
        const files = {};
        Object.entries(state.decisions.files).forEach(([id, entry]) => {
            const doc = state.docsById.get(id);
            // path и name — только для чтения человеком; при импорте игнорируются.
            files[id] = { path: doc ? doc.disk.path : null, name: doc ? doc.name : null, ...core.normalizeEntry(entry) };
        });
        const payload = { version: 2, updated_at: new Date().toISOString(), assignments: state.decisions.assignments, files };
        const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'review-decisions.v2.json';
        document.body.append(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        elements.message.textContent = 'Резервная копия экспортирована.';
    }

    async function importBackup(file) {
        if (!file) {
            return;
        }
        try {
            const parsed = JSON.parse(await file.text());
            let incoming;
            let skipped = 0;
            if (parsed && parsed.version === 2) {
                incoming = core.normalizeEnvelope(parsed);
            } else if (core.isV1(parsed)) {
                const result = core.convertV1Envelope(parsed, (path) => state.pathIndex.get(path) || null);
                incoming = result.envelope;
                skipped = result.unmatched.length;
            } else {
                throw new Error('Ожидался файл решений v1 или v2.');
            }
            let imported = 0;
            Object.entries(incoming.files).forEach(([id, entry]) => {
                if (!state.docsById.has(id)) {
                    skipped += 1;
                    return;
                }
                if (mergeIntoLocal(id, entry)) {
                    imported += 1;
                }
            });
            state.decisions.assignments = core.mergeAssignments(state.decisions.assignments, incoming.assignments);
            state.decisions.updated_at = new Date().toISOString();
            state.changesSinceSync += imported;
            state.autosaveStopped = false;
            saveLocalCache();
            applyAllDecisions();
            if (state.dirtyIds.size) {
                setSyncState('dirty', 'Есть несохранённые изменения');
            }
            elements.message.textContent = `Импортировано изменений: ${imported}${skipped ? `, пропущено (файл не найден): ${skipped}` : ''}.`;
        } catch (error) {
            elements.message.textContent = `Ошибка импорта: ${error.message}`;
        } finally {
            elements.importResults.value = '';
        }
    }

    // ---- запуск ----

    async function loadManifest() {
        const response = await fetch(`${CONFIG.manifestUrl}?v=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`manifest.json: HTTP ${response.status}`);
        }
        const manifest = await response.json();
        if (!manifest || !Array.isArray(manifest.documents) || manifest.documents.length === 0) {
            throw new Error('manifest.json пуст или повреждён');
        }
        state.manifest = manifest;
        state.docs = manifest.documents.filter((doc) => doc && doc.id && doc.disk && doc.disk.path);
        state.docsById = new Map(state.docs.map((doc) => [doc.id, doc]));
        state.pathIndex = core.buildPathIndex(manifest);
    }

    function bindEvents() {
        elements.catalog.addEventListener('click', (event) => {
            const toggle = event.target.closest('.folder-toggle');
            if (toggle) {
                const folder = toggle.closest('.folder');
                const collapsed = folder.classList.toggle('collapsed');
                toggle.textContent = collapsed ? '+' : '−';
                toggle.setAttribute('aria-expanded', String(!collapsed));
                return;
            }
            const row = event.target.closest('.file-row');
            if (!row) {
                return;
            }
            if (event.target.closest('.add-comment')) {
                row.dataset.editorOpen = 'true';
                renderComments(row);
                row.querySelector('.comment-draft').focus();
                return;
            }
            if (event.target.closest('.cancel-comment')) {
                row.dataset.editorOpen = 'false';
                renderComments(row);
                return;
            }
            if (event.target.closest('.save-comment')) {
                addComment(row);
                return;
            }
            const markOutcome = event.target.closest('.mark-outcome');
            if (markOutcome) {
                setOutcome(row, markOutcome.dataset.outcome);
                return;
            }
            if (event.target.closest('.clear-outcome')) {
                setOutcome(row, null);
                return;
            }
            if (event.target.closest('.show-comments')) {
                const count = entryFor(row.dataset.id).comments.length;
                const mode = row.dataset.commentMode || 'preview';
                row.dataset.commentMode = mode === 'preview'
                    ? count > 3 ? 'recent' : 'all'
                    : mode === 'recent' ? 'all' : 'preview';
                renderComments(row);
                return;
            }
            const statusButton = event.target.closest('.file-actions button[data-status]');
            if (statusButton) {
                chooseStatus(row, statusButton.dataset.status);
            }
        });

        elements.catalog.addEventListener('input', (event) => {
            if (event.target.matches('.comment-draft')) {
                saveDraft(event.target.closest('.file-row'), event.target.value);
            }
        });
        elements.catalog.addEventListener('change', (event) => {
            if (event.target.matches('.resolution-select')) {
                setResolution(event.target.closest('.file-row'), event.target.value || null);
            }
        });

        elements.filterButtons.forEach((button) => {
            button.addEventListener('click', () => {
                state.currentFilter = button.dataset.filter;
                applyFilter();
            });
        });
        elements.typeFilter.addEventListener('change', () => {
            state.typeFilter = elements.typeFilter.value;
            applyFilter();
        });
        elements.sizeFilter.addEventListener('change', () => {
            state.minSize = Number(elements.sizeFilter.value) || 0;
            applyFilter();
        });
        elements.viewMode.addEventListener('change', () => {
            state.viewMode = elements.viewMode.value;
            if (state.manifest) {
                renderCatalog();
                applyAllDecisions();
            }
        });
        elements.search.addEventListener('input', () => {
            state.searchTerm = elements.search.value.trim().toLocaleLowerCase('ru-RU');
            applyFilter();
        });
        elements.expandAll.addEventListener('click', () => {
            elements.folders.forEach((folder) => folder.classList.remove('collapsed'));
            elements.catalog.querySelectorAll('.folder-toggle').forEach((button) => {
                button.textContent = '−';
                button.setAttribute('aria-expanded', 'true');
            });
        });
        elements.collapseAll.addEventListener('click', () => {
            elements.folders.forEach((folder) => folder.classList.add('collapsed'));
            elements.catalog.querySelectorAll('.folder-toggle').forEach((button) => {
                button.textContent = '+';
                button.setAttribute('aria-expanded', 'false');
            });
        });
        elements.reviewer.addEventListener('change', saveReviewer);
        elements.token.addEventListener('input', () => {
            setToken(elements.token.value.trim());
            state.autosaveStopped = false;
        });
        elements.token.addEventListener('change', () => {
            if (state.manifest) loadRemoteDecisions();
        });
        elements.clearToken.addEventListener('click', () => {
            elements.token.value = '';
            setToken('');
            elements.message.textContent = 'GitHub token удалён из sessionStorage.';
        });
        elements.saveNow.addEventListener('click', () => {
            state.autosaveStopped = false;
            syncOnline();
        });
        elements.exportResults.addEventListener('click', exportBackup);
        elements.importResults.addEventListener('change', (event) => importBackup(event.target.files[0]));
    }

    function cacheElements() {
        const idMap = {
            catalog: 'catalog',
            countTotal: 'count-total',
            countReviewed: 'count-reviewed',
            countUnreviewed: 'count-unreviewed',
            progress: 'progress',
            search: 'file-search',
            typeFilter: 'type-filter',
            sizeFilter: 'size-filter',
            viewMode: 'view-mode',
            shownSummary: 'shown-summary',
            reviewer: 'reviewer',
            token: 'github-token',
            clearToken: 'clear-token',
            saveNow: 'save-now',
            syncState: 'sync-state',
            lastSync: 'last-sync',
            message: 'message',
            expandAll: 'expand-all',
            collapseAll: 'collapse-all',
            exportResults: 'export-results',
            importResults: 'import-results'
        };
        Object.entries(idMap).forEach(([name, id]) => {
            elements[name] = document.getElementById(id);
        });
        [...STATUSES, 'CONFLICT', 'TODO', 'DONE'].forEach((status) => {
            elements[`count${status}`] = document.getElementById(`count-${status}`);
        });
        elements.filterButtons = Array.from(document.querySelectorAll('button[data-filter]'));
        REVIEWERS.forEach((name) => {
            elements.reviewer.append(new Option(name === ARBITER ? `${name} (арбитр)` : name, name));
        });
    }

    async function start() {
        cacheElements();
        loadReviewer();
        elements.token.value = getToken();
        bindEvents();
        try {
            await loadManifest();
            fillTypeFilter();
            renderCatalog();
            const local = loadLocalCache();
            state.decisions = local.envelope;
            state.dirtyIds = new Set(local.dirtyIds.filter((id) => state.docsById.has(id)));
            const legacy = importLegacyCache();
            if (legacy.moved || legacy.unmatched) {
                saveLocalCache();
                elements.message.textContent = `Из прежней версии перенесено несохранённых изменений: ${legacy.moved}`
                    + (legacy.unmatched ? `, не найдено файлов: ${legacy.unmatched}` : '') + '.';
            }
            applyAllDecisions();
            await loadRemoteDecisions();
            setInterval(() => {
                if (state.dirtyIds.size > 0 && !state.autosaveStopped) {
                    syncOnline();
                }
            }, 15000);
        } catch (error) {
            setSyncState('error', `Ошибка запуска: ${error.message}`);
        }
    }

    window.addEventListener('DOMContentLoaded', start);
}());
