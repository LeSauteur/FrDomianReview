// Общая модель данных ревизии: используется страницей (window.FrDomianCore)
// и локальными Node-скриптами (require('./review-core.js')).
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.FrDomianCore = factory();
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const STATUSES = ['KEEP', 'ARCHIVE', 'UPDATE', 'DUPLICATE', 'DELETE', 'UNSURE'];
    const STATUS_SET = new Set(STATUSES);
    const ARBITER = 'Егупов Алексей';
    const REVIEWERS = ['Егупов Алексей', 'Андрейченко Валерий', 'Марина Олеговна'];
    // Автор, на которого записываются решения v1 без поля reviewer.
    const LEGACY_AUTHOR = ARBITER;
    const EPOCH = '1970-01-01T00:00:00.000Z';

    function normalizeStatus(value) {
        return STATUS_SET.has(value) ? value : null;
    }

    function isString(value) {
        return typeof value === 'string';
    }

    function timeOf(value) {
        const parsed = value ? Date.parse(value) : 0;
        return Number.isFinite(parsed) ? parsed : 0;
    }

    // ---- комментарии ----

    function normalizeComments(value) {
        if (!Array.isArray(value)) {
            return [];
        }
        const byId = new Map();
        value.forEach((comment) => {
            if (!comment || !isString(comment.id) || !comment.id.trim() || byId.has(comment.id)) {
                return;
            }
            byId.set(comment.id, {
                id: comment.id,
                author: isString(comment.author) ? comment.author : '',
                text: isString(comment.text) ? comment.text : '',
                created_at: isString(comment.created_at) ? comment.created_at : ''
            });
        });
        return Array.from(byId.values()).sort((left, right) =>
            left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id));
    }

    function mergeComments(base, incoming) {
        return normalizeComments([...normalizeComments(base), ...normalizeComments(incoming)]);
    }

    // ---- v2: голоса, решение арбитра ----

    // Голос {status, at}; status null — голос снят (надгробие, чтобы слияние его не воскресило).
    function normalizeVote(value) {
        if (!value || typeof value !== 'object' || !isString(value.at)) {
            return null;
        }
        return { status: normalizeStatus(value.status), at: value.at };
    }

    function normalizeResolution(value) {
        if (!value || typeof value !== 'object' || !isString(value.at)) {
            return null;
        }
        return {
            status: normalizeStatus(value.status),
            by: isString(value.by) ? value.by : '',
            at: value.at
        };
    }

    function emptyEntry() {
        return { votes: {}, resolution: null, comments: [] };
    }

    function normalizeEntry(value) {
        const entry = emptyEntry();
        if (!value || typeof value !== 'object') {
            return entry;
        }
        if (value.votes && typeof value.votes === 'object' && !Array.isArray(value.votes)) {
            Object.keys(value.votes).sort().forEach((name) => {
                const vote = normalizeVote(value.votes[name]);
                if (name && vote) {
                    entry.votes[name] = vote;
                }
            });
        }
        entry.resolution = normalizeResolution(value.resolution);
        entry.comments = normalizeComments(value.comments);
        return entry;
    }

    function isEntryEmpty(entry) {
        return Object.keys(entry.votes).length === 0 && !entry.resolution && entry.comments.length === 0;
    }

    function newer(base, incoming) {
        if (!base) return incoming;
        if (!incoming) return base;
        return timeOf(incoming.at) >= timeOf(base.at) ? incoming : base;
    }

    function mergeEntries(baseValue, incomingValue) {
        const base = normalizeEntry(baseValue);
        const incoming = normalizeEntry(incomingValue);
        const merged = emptyEntry();
        const names = new Set([...Object.keys(base.votes), ...Object.keys(incoming.votes)]);
        Array.from(names).sort().forEach((name) => {
            merged.votes[name] = newer(base.votes[name], incoming.votes[name]);
        });
        merged.resolution = newer(base.resolution, incoming.resolution);
        merged.comments = mergeComments(base.comments, incoming.comments);
        return merged;
    }

    function mergeFiles(baseFiles, incomingFiles) {
        const merged = {};
        const ids = new Set([...Object.keys(baseFiles || {}), ...Object.keys(incomingFiles || {})]);
        Array.from(ids).sort().forEach((id) => {
            const entry = mergeEntries((baseFiles || {})[id], (incomingFiles || {})[id]);
            if (!isEntryEmpty(entry)) {
                merged[id] = entry;
            }
        });
        return merged;
    }

    // Закрепление папок за проверяющими: { "<исходный путь папки>": { reviewers: [...], at } }.
    function normalizeAssignments(value) {
        const output = {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return output;
        }
        Object.keys(value).sort().forEach((folder) => {
            const item = value[folder];
            if (!item || !isString(item.at) || !Array.isArray(item.reviewers)) {
                return;
            }
            output[folder] = {
                reviewers: Array.from(new Set(item.reviewers.filter(isString))).sort(),
                at: item.at
            };
        });
        return output;
    }

    function mergeAssignments(base, incoming) {
        const left = normalizeAssignments(base);
        const right = normalizeAssignments(incoming);
        const output = {};
        new Set([...Object.keys(left), ...Object.keys(right)]).forEach((folder) => {
            output[folder] = newer(left[folder], right[folder]);
        });
        return normalizeAssignments(output);
    }

    function emptyEnvelope() {
        return { version: 2, updated_at: null, assignments: {}, files: {} };
    }

    function normalizeEnvelope(value) {
        const output = emptyEnvelope();
        if (!value || typeof value !== 'object' || value.version !== 2) {
            return output;
        }
        output.updated_at = isString(value.updated_at) ? value.updated_at : null;
        output.assignments = normalizeAssignments(value.assignments);
        output.files = mergeFiles({}, value.files && typeof value.files === 'object' ? value.files : {});
        return output;
    }

    function mergeEnvelopes(base, incoming) {
        const left = normalizeEnvelope(base);
        const right = normalizeEnvelope(incoming);
        return {
            version: 2,
            updated_at: timeOf(right.updated_at) >= timeOf(left.updated_at) ? right.updated_at : left.updated_at,
            assignments: mergeAssignments(left.assignments, right.assignments),
            files: mergeFiles(left.files, right.files)
        };
    }

    // Итоговый статус: решение арбитра > единственный статус среди голосов > конфликт.
    function effectiveStatus(value) {
        const entry = normalizeEntry(value);
        if (entry.resolution && entry.resolution.status) {
            return { status: entry.resolution.status, resolved: true, conflict: false };
        }
        const statuses = new Set(Object.values(entry.votes).map((vote) => vote.status).filter(Boolean));
        if (statuses.size === 0) {
            return { status: null, resolved: false, conflict: false };
        }
        if (statuses.size === 1) {
            return { status: statuses.values().next().value, resolved: false, conflict: false };
        }
        return { status: null, resolved: false, conflict: true };
    }

    // ---- совместимость с v1 (ключ — путь, один статус на файл) ----

    function isV1(value) {
        return Boolean(value && typeof value === 'object' && value.version !== 2
            && value.files && typeof value.files === 'object' && !Array.isArray(value.files));
    }

    function convertV1Decision(value, legacyAuthor) {
        const entry = emptyEntry();
        if (!value || typeof value !== 'object') {
            return entry;
        }
        const status = normalizeStatus(value.status);
        const at = isString(value.reviewed_at) && value.reviewed_at ? value.reviewed_at : null;
        const author = isString(value.reviewer) && value.reviewer ? value.reviewer : (legacyAuthor || LEGACY_AUTHOR);
        if (at) {
            entry.votes[author] = { status, at };
        } else if (status) {
            entry.votes[author] = { status, at: EPOCH };
        }
        entry.comments = normalizeComments(value.comments);
        return entry;
    }

    // resolveId(path) -> id | null. paths — если задан, конвертируются только эти пути.
    function convertV1Envelope(value, resolveId, options) {
        const settings = options || {};
        const envelope = emptyEnvelope();
        const unmatched = [];
        if (!isV1(value)) {
            return { envelope, unmatched, converted: 0 };
        }
        const only = settings.paths ? new Set(settings.paths) : null;
        let converted = 0;
        Object.keys(value.files).forEach((path) => {
            if (only && !only.has(path)) {
                return;
            }
            const entry = convertV1Decision(value.files[path], settings.legacyAuthor);
            if (isEntryEmpty(entry)) {
                return;
            }
            const id = resolveId(path);
            if (!id) {
                unmatched.push(path);
                return;
            }
            envelope.files[id] = mergeEntries(envelope.files[id], entry);
            converted += 1;
        });
        envelope.updated_at = isString(value.updated_at) ? value.updated_at : null;
        return { envelope, unmatched, converted };
    }

    // ---- манифест ----

    // Карта путь -> id: текущий путь, исходный путь и все прежние пути документа.
    function buildPathIndex(manifest) {
        const map = new Map();
        const documents = manifest && Array.isArray(manifest.documents) ? manifest.documents : [];
        documents.forEach((doc) => {
            const history = doc.history || {};
            [doc.disk && doc.disk.path, history.original_path, ...(history.previous_paths || [])]
                .filter(isString)
                .forEach((path) => {
                    if (!map.has(path)) {
                        map.set(path, doc.id);
                    }
                });
        });
        return map;
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

    return {
        STATUSES,
        REVIEWERS,
        ARBITER,
        LEGACY_AUTHOR,
        normalizeStatus,
        normalizeComments,
        mergeComments,
        normalizeEntry,
        emptyEntry,
        isEntryEmpty,
        mergeEntries,
        mergeFiles,
        normalizeAssignments,
        mergeAssignments,
        emptyEnvelope,
        normalizeEnvelope,
        mergeEnvelopes,
        effectiveStatus,
        isV1,
        convertV1Decision,
        convertV1Envelope,
        buildPathIndex,
        matchesFile
    };
}));
