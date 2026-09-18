(function () {
    'use strict';

    const CONFIG = {
        owner: 'LeSauteur',
        repository: 'FrDomianReview',
        branch: 'main',
        indexUrl: 'data/yandex-disk-index.json',
        decisionsUrl: 'data/review-decisions.json',
        decisionsPath: 'data/review-decisions.json',
        expectedFiles: 657,
        apiVersion: '2022-11-28'
    };
    const STATUSES = ['KEEP', 'ARCHIVE', 'UPDATE', 'DUPLICATE', 'DELETE', 'UNSURE'];
    const STATUS_SET = new Set(STATUSES);
    const REVIEWERS = ['Егупов Алексей', 'Андрейченко Валерий', 'Марина Олеговна'];
    const CACHE_KEY = 'frdomian-review.cache.v1';
    const REVIEWER_KEY = 'frdomian-review.reviewer.v1';
    const TOKEN_KEY = 'frdomian-review.github-token.v1';
    const DRAFT_PREFIX = 'frdomian-review.comment-draft.v1:';

    const state = {
        indexFiles: [],
        filesByPath: new Map(),
        rowsByPath: new Map(),
        decisions: emptyEnvelope(),
        dirtyPaths: new Set(),
        currentFilter: 'ALL',
        searchTerm: '',
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

    function emptyEnvelope() {
        return { version: 1, updated_at: null, files: {} };
    }

    function normalizeStatus(value) {
        return STATUS_SET.has(value) ? value : null;
    }

    function normalizeComments(value) {
        if (!Array.isArray(value)) {
            return [];
        }
        const byId = new Map();
        value.forEach((comment) => {
            if (!comment || typeof comment.id !== 'string' || !comment.id.trim() || byId.has(comment.id)) {
                return;
            }
            byId.set(comment.id, {
                id: comment.id,
                author: typeof comment.author === 'string' ? comment.author : '',
                text: typeof comment.text === 'string' ? comment.text : '',
                created_at: typeof comment.created_at === 'string' ? comment.created_at : ''
            });
        });
        return Array.from(byId.values()).sort((left, right) =>
            left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
    }

    function mergeComments(base, incoming) {
        return normalizeComments([...normalizeComments(base), ...normalizeComments(incoming)]);
    }

    function normalizeDecision(value) {
        if (!value || typeof value !== 'object') {
            return null;
        }
        return {
            name: typeof value.name === 'string' ? value.name : '',
            status: normalizeStatus(value.status),
            reviewed_at: typeof value.reviewed_at === 'string' ? value.reviewed_at : null,
            reviewer: typeof value.reviewer === 'string' ? value.reviewer : '',
            comments: normalizeComments(value.comments)
        };
    }

    function normalizeEnvelope(value) {
        const output = emptyEnvelope();
        if (!value || typeof value !== 'object') {
            return output;
        }
        output.updated_at = typeof value.updated_at === 'string' ? value.updated_at : null;
        const sourceFiles = value.files && typeof value.files === 'object' && !Array.isArray(value.files)
            ? value.files
            : {};
        Object.entries(sourceFiles).forEach(([path, decision]) => {
            const normalized = normalizeDecision(decision);
            if (normalized) {
                output.files[path] = normalized;
            }
        });
        return output;
    }

    function decisionTime(value) {
        const timestamp = value && value.reviewed_at ? Date.parse(value.reviewed_at) : 0;
        return Number.isFinite(timestamp) ? timestamp : 0;
    }

    function mergeDecisionFiles(baseFiles, incomingFiles) {
        const merged = {};
        const paths = new Set([...Object.keys(baseFiles || {}), ...Object.keys(incomingFiles || {})]);
        paths.forEach((path) => {
            const base = normalizeDecision((baseFiles || {})[path]);
            const incoming = normalizeDecision((incomingFiles || {})[path]);
            if (!base) {
                merged[path] = incoming;
                return;
            }
            if (!incoming) {
                merged[path] = base;
                return;
            }
            const newer = decisionTime(incoming) >= decisionTime(base) ? incoming : base;
            merged[path] = {
                name: newer.name || base.name || incoming.name,
                status: newer.status,
                reviewed_at: newer.reviewed_at,
                reviewer: newer.reviewer,
                comments: mergeComments(base.comments, incoming.comments)
            };
        });
        return merged;
    }

    function matchesFile(name, path, status, commentCount, filter, searchTerm) {
        const statusMatches = filter === 'ALL'
            || (filter === 'UNREVIEWED' && !status)
            || (filter === 'COMMENTS' && commentCount > 0)
            || status === filter;
        const searchMatches = !searchTerm
            || `${name} ${path}`.toLocaleLowerCase('ru-RU').includes(searchTerm);
        return statusMatches && searchMatches;
    }

    function cacheAvailable() {
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
        if (!cacheAvailable()) {
            return { envelope: emptyEnvelope(), dirtyPaths: [] };
        }
        try {
            const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
            return {
                envelope: normalizeEnvelope(parsed),
                dirtyPaths: Array.isArray(parsed.dirty_paths)
                    ? parsed.dirty_paths.filter((path) => typeof path === 'string')
                    : []
            };
        } catch (error) {
            return { envelope: emptyEnvelope(), dirtyPaths: [] };
        }
    }

    function saveLocalCache() {
        if (!cacheAvailable()) {
            setSyncState('error', 'Локальное сохранение недоступно');
            return false;
        }
        const payload = {
            version: 1,
            updated_at: state.decisions.updated_at,
            files: state.decisions.files,
            dirty_paths: Array.from(state.dirtyPaths)
        };
        localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
        return true;
    }

    function githubApiUrl() {
        const encodedPath = CONFIG.decisionsPath.split('/').map(encodeURIComponent).join('/');
        return `https://api.github.com/repos/${CONFIG.owner}/${CONFIG.repository}/contents/${encodedPath}?ref=${encodeURIComponent(CONFIG.branch)}`;
    }

    function githubHeaders(token, includeJson) {
        const headers = {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': CONFIG.apiVersion
        };
        if (includeJson) {
            headers['Content-Type'] = 'application/json';
        }
        if (token) {
            headers.Authorization = `Bearer ${token}`;
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
        return {
            sha: metadata.sha,
            envelope: normalizeEnvelope(JSON.parse(decodeBase64Utf8(metadata.content)))
        };
    }

    async function readPublishedDecisions() {
        const response = await fetch(`${CONFIG.decisionsUrl}?v=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) {
            throw new Error(`Published decisions returned HTTP ${response.status}`);
        }
        return normalizeEnvelope(await response.json());
    }

    async function putGitHubDecisions(token, sha, envelope) {
        const body = {
            message: 'Update review decisions',
            content: encodeBase64Utf8(`${JSON.stringify(envelope, null, 2)}\n`),
            sha,
            branch: CONFIG.branch
        };
        const response = await fetch(githubApiUrl(), {
            method: 'PUT',
            headers: githubHeaders(token, true),
            body: JSON.stringify(body)
        });
        if (!response.ok) {
            throw new GitHubHttpError(response.status);
        }
        return response.json();
    }

    function setSyncState(kind, text) {
        elements.syncState.dataset.state = kind;
        elements.syncState.textContent = text;
    }

    function formatSyncTime(value) {
        if (!value) {
            return 'ещё не выполнялась';
        }
        const parsed = new Date(value);
        return Number.isNaN(parsed.valueOf()) ? value : parsed.toLocaleString('ru-RU');
    }

    function updateLastSync() {
        elements.lastSync.textContent = `Последняя синхронизация: ${formatSyncTime(state.lastSyncedAt)}`;
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
        document.querySelectorAll('.comment-author-selected').forEach((label) => {
            label.textContent = getReviewer() || 'Выберите проверяющего в верхней панели';
        });
    }

    function draftKey(path) {
        return `${DRAFT_PREFIX}${encodeURIComponent(path)}`;
    }

    function loadDraft(path) {
        try {
            return localStorage.getItem(draftKey(path)) || '';
        } catch (error) {
            return '';
        }
    }

    function saveDraft(path, text) {
        try {
            localStorage.setItem(draftKey(path), text);
        } catch (error) {
            setSyncState('error', 'Не удалось сохранить черновик локально');
        }
    }

    function clearDraft(path) {
        try {
            localStorage.removeItem(draftKey(path));
        } catch (error) {
            setSyncState('error', 'Не удалось очистить черновик');
        }
    }

    function statusForPath(path) {
        return normalizeStatus(state.decisions.files[path] && state.decisions.files[path].status);
    }

    function applyDecisionToRow(row) {
        const status = statusForPath(row.dataset.path);
        row.dataset.status = status || '';
        row.classList.toggle('reviewed', Boolean(status));
        row.querySelectorAll('button[data-status]').forEach((button) => {
            const selected = button.dataset.status === status;
            button.classList.toggle('selected', selected);
            button.setAttribute('aria-pressed', String(selected));
        });
        renderCommentsForRow(row);
    }

    function formatCommentDate(value) {
        const date = new Date(value);
        return Number.isNaN(date.valueOf()) ? value : date.toLocaleString('ru-RU');
    }

    function commentButton(className, label) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.textContent = label;
        return button;
    }

    function renderCommentsForRow(row) {
        const area = row.querySelector('.comments-area');
        if (!area) {
            return;
        }
        const path = row.dataset.path;
        const decision = state.decisions.files[path];
        const comments = normalizeComments(decision && decision.comments);
        const mode = row.dataset.commentMode || 'preview';
        const editorOpen = row.dataset.editorOpen === 'true';
        area.replaceChildren();

        if (comments.length > 0) {
            const summary = document.createElement('div');
            summary.className = 'comment-summary';
            const count = document.createElement('span');
            count.className = 'comment-count';
            count.textContent = `Комментарии: ${comments.length}`;
            summary.append(count);
            const add = commentButton('add-comment', 'Добавить комментарий');
            summary.append(add);
            area.append(summary);

            const shown = mode === 'all' ? comments
                : mode === 'recent' ? comments.slice(-3)
                    : comments.slice(-1);
            const list = document.createElement('div');
            list.className = 'comment-list';
            shown.forEach((comment) => {
                const item = document.createElement('div');
                item.className = 'comment-item';
                const heading = document.createElement('div');
                heading.className = 'comment-heading';
                const author = document.createElement('strong');
                author.className = 'comment-author';
                author.textContent = comment.author || 'Автор не указан';
                const date = document.createElement('time');
                date.className = 'comment-date';
                date.dateTime = comment.created_at;
                date.textContent = formatCommentDate(comment.created_at);
                heading.append(author, date);
                const text = document.createElement('p');
                text.className = 'comment-text';
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

        if (editorOpen) {
            const editor = document.createElement('div');
            editor.className = 'comment-editor';
            const author = document.createElement('div');
            author.className = 'comment-author-selected';
            author.textContent = getReviewer() || 'Выберите проверяющего в верхней панели';
            const textarea = document.createElement('textarea');
            textarea.className = 'comment-draft';
            textarea.rows = 3;
            textarea.placeholder = 'Комментарий по файлу…';
            textarea.value = loadDraft(path);
            const actions = document.createElement('div');
            actions.className = 'comment-editor-actions';
            actions.append(
                commentButton('save-comment', 'Сохранить комментарий'),
                commentButton('cancel-comment', 'Отмена')
            );
            editor.append(author, textarea, actions);
            area.append(editor);
        }
    }

    function addComment(row) {
        const reviewer = getReviewer();
        if (!reviewer) {
            elements.message.textContent = 'Сначала выберите проверяющего.';
            elements.reviewer.focus();
            return;
        }
        const textarea = row.querySelector('.comment-draft');
        const text = textarea ? textarea.value.trim() : '';
        if (!text) {
            elements.message.textContent = 'Введите текст комментария.';
            if (textarea) textarea.focus();
            return;
        }

        const path = row.dataset.path;
        const current = normalizeDecision(state.decisions.files[path]) || {
            name: row.dataset.name,
            status: null,
            reviewed_at: null,
            reviewer: '',
            comments: []
        };
        current.name = row.dataset.name;
        current.comments = mergeComments(current.comments, [{
            id: crypto.randomUUID(),
            author: reviewer,
            text,
            created_at: new Date().toISOString()
        }]);
        state.decisions.files[path] = current;
        state.dirtyPaths.add(path);
        state.changesSinceSync += 1;
        state.decisions.updated_at = new Date().toISOString();
        saveLocalCache();
        clearDraft(path);
        row.dataset.editorOpen = 'false';
        renderCommentsForRow(row);
        applyFilter();
        setSyncState('dirty', 'Есть несохранённые изменения');
        elements.message.textContent = 'Комментарий сохранён локально.';
        if (!state.autosaveStopped) {
            syncOnline();
        }
    }

    function applyAllDecisions() {
        state.rowsByPath.forEach((row) => applyDecisionToRow(row));
        updateCounters();
        applyFilter();
    }

    function updateCounters() {
        const counts = Object.fromEntries(STATUSES.map((status) => [status, 0]));
        let reviewed = 0;
        state.indexFiles.forEach((file) => {
            const status = statusForPath(file.path);
            if (status) {
                counts[status] += 1;
                reviewed += 1;
            }
        });
        const total = state.indexFiles.length;
        const percent = total ? (reviewed * 100 / total).toLocaleString('ru-RU', {
            minimumFractionDigits: 1,
            maximumFractionDigits: 1
        }) : '0,0';
        elements.countTotal.textContent = String(total);
        elements.countReviewed.textContent = String(reviewed);
        elements.countUnreviewed.textContent = String(total - reviewed);
        elements.progress.textContent = `${reviewed} / ${total} — ${percent}%`;
        STATUSES.forEach((status) => {
            elements[`count${status}`].textContent = String(counts[status]);
        });
    }

    function applyFilter() {
        state.rowsByPath.forEach((row, path) => {
            const status = statusForPath(path);
            const comments = normalizeComments(state.decisions.files[path] && state.decisions.files[path].comments);
            row.hidden = !matchesFile(row.dataset.name, path, status, comments.length,
                state.currentFilter, state.searchTerm);
        });

        elements.folders.forEach((folder) => {
            folder.hidden = !folder.querySelector('.file-row:not([hidden])');
        });
        elements.filterButtons.forEach((button) => {
            button.classList.toggle('active-filter', button.dataset.filter === state.currentFilter);
        });
    }

    function chooseStatus(row, requestedStatus) {
        const reviewer = getReviewer();
        if (!reviewer) {
            elements.message.textContent = 'Сначала выберите проверяющего.';
            elements.reviewer.focus();
            return;
        }
        const path = row.dataset.path;
        const current = statusForPath(path);
        const next = current === requestedStatus ? null : requestedStatus;
        const previous = normalizeDecision(state.decisions.files[path]);
        state.decisions.files[path] = {
            name: row.dataset.name,
            status: next,
            reviewed_at: new Date().toISOString(),
            reviewer,
            comments: previous ? previous.comments : []
        };
        state.dirtyPaths.add(path);
        state.changesSinceSync += 1;
        state.decisions.updated_at = new Date().toISOString();
        saveLocalCache();
        applyDecisionToRow(row);
        updateCounters();
        applyFilter();
        setSyncState('dirty', 'Есть несохранённые изменения');

        if (state.changesSinceSync >= 10 && !state.autosaveStopped) {
            syncOnline();
        }
    }

    function mergeRemoteWithLocal(remoteEnvelope) {
        return {
            version: 1,
            updated_at: remoteEnvelope.updated_at,
            files: mergeDecisionFiles(remoteEnvelope.files, state.decisions.files)
        };
    }

    async function syncOnline() {
        if (state.syncing || state.dirtyPaths.size === 0 || state.autosaveStopped) {
            return;
        }
        const token = getToken();
        if (!token) {
            setSyncState('dirty', 'Есть несохранённые изменения — введите GitHub token');
            return;
        }

        state.syncing = true;
        const dirtyAtStart = new Map(Array.from(state.dirtyPaths, (path) =>
            [path, JSON.stringify(state.decisions.files[path])]
        ));
        setSyncState('dirty', 'Синхронизация…');
        try {
            let remote = await readGitHubDecisions(token);
            let merged = mergeRemoteWithLocal(remote.envelope);
            merged.updated_at = new Date().toISOString();

            try {
                await putGitHubDecisions(token, remote.sha, merged);
            } catch (error) {
                if (!(error instanceof GitHubHttpError) || error.status !== 409) {
                    throw error;
                }
                remote = await readGitHubDecisions(token);
                merged = {
                    version: 1,
                    updated_at: new Date().toISOString(),
                    files: mergeDecisionFiles(remote.envelope.files, merged.files)
                };
                await putGitHubDecisions(token, remote.sha, merged);
            }

            const pendingPaths = new Set();
            state.dirtyPaths.forEach((path) => {
                if (!dirtyAtStart.has(path)
                    || JSON.stringify(state.decisions.files[path]) !== dirtyAtStart.get(path)) {
                    pendingPaths.add(path);
                }
            });
            state.decisions = {
                version: 1,
                updated_at: pendingPaths.size ? state.decisions.updated_at : merged.updated_at,
                files: mergeDecisionFiles(merged.files, state.decisions.files)
            };
            state.dirtyPaths = pendingPaths;
            state.changesSinceSync = pendingPaths.size;
            state.autosaveStopped = false;
            state.lastSyncedAt = merged.updated_at;
            saveLocalCache();
            applyAllDecisions();
            updateLastSync();
            setSyncState(pendingPaths.size ? 'dirty' : 'saved',
                pendingPaths.size ? 'Есть несохранённые изменения' : 'Сохранено онлайн');
        } catch (error) {
            state.autosaveStopped = true;
            const suffix = error instanceof GitHubHttpError ? ` (HTTP ${error.status})` : '';
            setSyncState('error', `Ошибка синхронизации${suffix}`);
        } finally {
            state.syncing = false;
        }
    }

    function buildBackup() {
        const files = {};
        state.indexFiles.forEach((file) => {
            const decision = state.decisions.files[file.path];
            const status = normalizeStatus(decision && decision.status);
            files[file.path] = {
                name: file.name,
                viewer_url: file.viewer_url,
                status,
                reviewed_at: status && decision ? decision.reviewed_at : null,
                reviewer: status && decision ? decision.reviewer : '',
                comments: normalizeComments(decision && decision.comments)
            };
        });
        return {
            version: 1,
            updated_at: new Date().toISOString(),
            files
        };
    }

    function exportBackup() {
        const payload = buildBackup();
        const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
            type: 'application/json;charset=utf-8'
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'review-decisions.json';
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
            const importedFiles = parsed && parsed.files && typeof parsed.files === 'object'
                ? parsed.files
                : null;
            if (!importedFiles) {
                throw new Error('Ожидался объект files.');
            }
            let imported = 0;
            Object.entries(importedFiles).forEach(([path, value]) => {
                if (!state.filesByPath.has(path)) {
                    return;
                }
                const normalized = normalizeDecision(value) || {
                    name: state.filesByPath.get(path).name,
                    status: null,
                    reviewed_at: null,
                    reviewer: '',
                    comments: []
                };
                normalized.name = state.filesByPath.get(path).name;
                state.decisions.files[path] = mergeDecisionFiles(
                    { [path]: state.decisions.files[path] }, { [path]: normalized }
                )[path];
                state.dirtyPaths.add(path);
                imported += 1;
            });
            state.decisions.updated_at = new Date().toISOString();
            state.changesSinceSync += imported;
            state.autosaveStopped = false;
            saveLocalCache();
            applyAllDecisions();
            setSyncState('dirty', 'Есть несохранённые изменения');
            elements.message.textContent = `Импортировано решений: ${imported}.`;
        } catch (error) {
            elements.message.textContent = `Ошибка импорта: ${error.message}`;
        } finally {
            elements.importResults.value = '';
        }
    }

    async function loadIndex() {
        try {
            const response = await fetch(CONFIG.indexUrl, { cache: 'no-store' });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            const entries = await response.json();
            state.indexFiles = entries
                .filter((entry) => entry && entry.type === 'file')
                .map((entry) => ({
                    path: String(entry.path || ''),
                    name: String(entry.name || ''),
                    viewer_url: String(entry.viewer_url || '')
                }));
        } catch (error) {
            state.indexFiles = Array.from(state.rowsByPath.values()).map((row) => ({
                path: row.dataset.path,
                name: row.dataset.name,
                viewer_url: row.querySelector('.file-name').getAttribute('href')
            }));
            elements.message.textContent = 'Индекс взят из встроенного HTML: локальный fallback.';
        }

        if (state.indexFiles.length !== CONFIG.expectedFiles) {
            throw new Error(`Ожидалось ${CONFIG.expectedFiles} файлов, найдено ${state.indexFiles.length}.`);
        }
        if (state.indexFiles.some((file) => !file.path || !file.viewer_url)) {
            throw new Error('В индексе есть файл без path или viewer_url.');
        }
        state.filesByPath = new Map(state.indexFiles.map((file) => [file.path, file]));
    }

    async function loadInitialDecisions() {
        const local = loadLocalCache();
        state.dirtyPaths = new Set(local.dirtyPaths.filter((path) => state.filesByPath.has(path)));
        let remoteEnvelope = emptyEnvelope();

        try {
            const remote = await readGitHubDecisions(getToken());
            remoteEnvelope = remote.envelope;
            setSyncState('saved', 'Онлайн-решения загружены');
        } catch (githubError) {
            try {
                remoteEnvelope = await readPublishedDecisions();
                setSyncState('saved', 'Опубликованные решения загружены');
            } catch (publishedError) {
                setSyncState('dirty', 'Онлайн недоступен — используется локальная копия');
            }
        }

        state.decisions = {
            version: 1,
            updated_at: remoteEnvelope.updated_at || local.envelope.updated_at,
            files: mergeDecisionFiles(remoteEnvelope.files, local.envelope.files)
        };
        state.lastSyncedAt = remoteEnvelope.updated_at;
        saveLocalCache();
        applyAllDecisions();
        updateLastSync();
        if (state.dirtyPaths.size > 0) {
            setSyncState('dirty', 'Есть несохранённые изменения');
        }
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
                renderCommentsForRow(row);
                row.querySelector('.comment-draft').focus();
                return;
            }
            if (event.target.closest('.cancel-comment')) {
                row.dataset.editorOpen = 'false';
                renderCommentsForRow(row);
                return;
            }
            if (event.target.closest('.save-comment')) {
                addComment(row);
                return;
            }
            if (event.target.closest('.show-comments')) {
                const count = normalizeComments(state.decisions.files[row.dataset.path]
                    && state.decisions.files[row.dataset.path].comments).length;
                const mode = row.dataset.commentMode || 'preview';
                row.dataset.commentMode = mode === 'preview'
                    ? count > 3 ? 'recent' : 'all'
                    : mode === 'recent' ? 'all' : 'preview';
                renderCommentsForRow(row);
                return;
            }
            const statusButton = event.target.closest('button[data-status]');
            if (statusButton) {
                chooseStatus(row, statusButton.dataset.status);
            }
        });

        elements.catalog.addEventListener('input', (event) => {
            if (event.target.matches('.comment-draft')) {
                const row = event.target.closest('.file-row');
                saveDraft(row.dataset.path, event.target.value);
            }
        });

        elements.filterButtons.forEach((button) => {
            button.addEventListener('click', () => {
                state.currentFilter = button.dataset.filter;
                applyFilter();
            });
        });
        elements.search.addEventListener('input', () => {
            state.searchTerm = elements.search.value.trim().toLocaleLowerCase('ru-RU');
            applyFilter();
        });
        elements.expandAll.addEventListener('click', () => {
            elements.folders.forEach((folder) => folder.classList.remove('collapsed'));
            document.querySelectorAll('.folder-toggle').forEach((button) => {
                button.textContent = '−';
                button.setAttribute('aria-expanded', 'true');
            });
        });
        elements.collapseAll.addEventListener('click', () => {
            elements.folders.forEach((folder) => folder.classList.add('collapsed'));
            document.querySelectorAll('.folder-toggle').forEach((button) => {
                button.textContent = '+';
                button.setAttribute('aria-expanded', 'false');
            });
        });
        elements.reviewer.addEventListener('change', saveReviewer);
        elements.token.addEventListener('input', () => {
            setToken(elements.token.value.trim());
            state.autosaveStopped = false;
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
        STATUSES.forEach((status) => {
            elements[`count${status}`] = document.getElementById(`count-${status}`);
        });
        elements.filterButtons = Array.from(document.querySelectorAll('button[data-filter]'));
        elements.folders = Array.from(document.querySelectorAll('.folder'))
            .sort((left, right) => Number(right.dataset.depth) - Number(left.dataset.depth));
        elements.rows = Array.from(document.querySelectorAll('.file-row'));
        state.rowsByPath = new Map(elements.rows.map((row) => [row.dataset.path, row]));
    }

    async function start() {
        cacheElements();
        loadReviewer();
        elements.token.value = getToken();
        bindEvents();
        try {
            await loadIndex();
            await loadInitialDecisions();
            setInterval(() => {
                if (state.dirtyPaths.size > 0 && !state.autosaveStopped) {
                    syncOnline();
                }
            }, 15000);
        } catch (error) {
            setSyncState('error', `Ошибка запуска: ${error.message}`);
        }
    }

    if (typeof document === 'undefined') {
        globalThis.FrDomianReviewTest = {
            normalizeComments,
            normalizeDecision,
            normalizeEnvelope,
            mergeComments,
            mergeDecisionFiles,
            matchesFile,
            emptyEnvelope,
            STATUSES,
            REVIEWERS
        };
        return;
    }

    window.addEventListener('DOMContentLoaded', start);
}());
