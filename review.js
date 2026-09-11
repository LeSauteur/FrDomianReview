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
    const CACHE_KEY = 'frdomian-review.cache.v1';
    const REVIEWER_KEY = 'frdomian-review.reviewer.v1';
    const TOKEN_KEY = 'frdomian-review.github-token.v1';

    const state = {
        indexFiles: [],
        filesByPath: new Map(),
        rowsByPath: new Map(),
        decisions: emptyEnvelope(),
        dirtyPaths: new Set(),
        currentFilter: 'ALL',
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

    function normalizeDecision(value) {
        if (!value || typeof value !== 'object') {
            return null;
        }
        return {
            name: typeof value.name === 'string' ? value.name : '',
            status: normalizeStatus(value.status),
            reviewed_at: typeof value.reviewed_at === 'string' ? value.reviewed_at : null,
            reviewer: typeof value.reviewer === 'string' ? value.reviewer : ''
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
        const merged = { ...baseFiles };
        Object.entries(incomingFiles || {}).forEach(([path, incoming]) => {
            const current = merged[path];
            if (!current || decisionTime(incoming) >= decisionTime(current)) {
                merged[path] = incoming;
            }
        });
        return merged;
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
        elements.lastSync.textContent = `Последняя синхронизация: ${formatSyncTime(state.decisions.updated_at)}`;
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
        return elements.reviewer.value.trim();
    }

    function loadReviewer() {
        try {
            elements.reviewer.value = localStorage.getItem(REVIEWER_KEY) || '';
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
            const visible = state.currentFilter === 'ALL'
                || (state.currentFilter === 'UNREVIEWED' && !status)
                || status === state.currentFilter;
            row.hidden = !visible;
        });

        elements.folders.forEach((folder) => {
            folder.hidden = !folder.querySelector('.file-row:not([hidden])');
        });
        elements.filterButtons.forEach((button) => {
            button.classList.toggle('active-filter', button.dataset.filter === state.currentFilter);
        });
    }

    function chooseStatus(row, requestedStatus) {
        const path = row.dataset.path;
        const current = statusForPath(path);
        const next = current === requestedStatus ? null : requestedStatus;
        state.decisions.files[path] = {
            name: row.dataset.name,
            status: next,
            reviewed_at: new Date().toISOString(),
            reviewer: getReviewer()
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
        const localFiles = state.decisions.files;
        state.dirtyPaths.forEach((path) => {
            const remoteDecision = remoteEnvelope.files[path];
            const localDecision = localFiles[path];
            if (remoteDecision && localDecision && decisionTime(remoteDecision) > decisionTime(localDecision)) {
                state.dirtyPaths.delete(path);
            }
        });
        return {
            version: 1,
            updated_at: remoteEnvelope.updated_at,
            files: mergeDecisionFiles(remoteEnvelope.files, localFiles)
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

            state.decisions = merged;
            state.dirtyPaths.clear();
            state.changesSinceSync = 0;
            state.autosaveStopped = false;
            saveLocalCache();
            applyAllDecisions();
            updateLastSync();
            setSyncState('saved', 'Сохранено онлайн');
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
                reviewer: status && decision ? decision.reviewer : ''
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
                    reviewed_at: new Date().toISOString(),
                    reviewer: ''
                };
                normalized.name = state.filesByPath.get(path).name;
                normalized.reviewed_at = normalized.reviewed_at || new Date().toISOString();
                state.decisions.files[path] = normalized;
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
        state.dirtyPaths.forEach((path) => {
            const remoteDecision = remoteEnvelope.files[path];
            const localDecision = local.envelope.files[path];
            if (remoteDecision && localDecision && decisionTime(remoteDecision) > decisionTime(localDecision)) {
                state.dirtyPaths.delete(path);
            }
        });
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
            const statusButton = event.target.closest('button[data-status]');
            if (statusButton) {
                chooseStatus(row, statusButton.dataset.status);
            }
        });

        elements.filterButtons.forEach((button) => {
            button.addEventListener('click', () => {
                state.currentFilter = button.dataset.filter;
                applyFilter();
            });
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
        elements.reviewer.addEventListener('input', saveReviewer);
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

    window.addEventListener('DOMContentLoaded', start);
}());
