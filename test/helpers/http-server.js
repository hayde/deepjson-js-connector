// Stub DeepJSON HTTP server for the tests. It authenticates nothing: any
// username/password is accepted and the tokens are obvious fakes, so no real
// credentials ever appear in this repository.
'use strict';

const http = require('http');

const FAKE_TOKEN = 'test-token-initial';

/**  Successive renewal tokens: test-token-1, test-token-2, ... */
function tokenSeries() {
    let n = 0;
    return () => `test-token-${++n}`;
}

/** Mirrors the server's etagFor(): quoted _modCounter, null when absent. */
function etagFor(doc) {
    return doc === undefined ? null : `"${doc._modCounter || 0}"`;
}

/** Mirrors the server's etagMatches(): lenient on quoting and W/ prefixes. */
function etagMatches(headerValue, currentEtag) {
    const normalize = (v) => String(v).trim().replace(/^W\//i, '').replace(/^"|"$/g, '');
    const raw = String(headerValue).trim();
    if (raw === '*') return currentEtag !== null;
    if (currentEtag === null) return false;
    const current = normalize(currentEtag);
    return raw.split(',').some(c => normalize(c) === current);
}

/**
 * Mirrors the server's handleListKeys(): same filtering order, same bound
 * validation, same key_list_limit ceiling, same payload shape.
 */
function listKeys(source, allKeys, keyListLimit) {
    const asBound = (value, name) => {
        if (value === undefined || value === '') return undefined;
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) {
            return { error: `"${name}" must be a non-negative integer (got ${JSON.stringify(value)})` };
        }
        return n;
    };

    const offset = asBound(source.offset, 'offset');
    if (offset && offset.error) return { status: 400, body: offset };
    let limit = asBound(source.limit, 'limit');
    if (limit && limit.error) return { status: 400, body: limit };

    const maxLimit = Number(keyListLimit) || undefined;
    if (maxLimit !== undefined) limit = limit === undefined ? maxLimit : Math.min(limit, maxLimit);

    let keys = allKeys.slice();
    if (source.keys) {
        let matcher;
        try { matcher = new RegExp(source.keys); }
        catch (err) {
            return { status: 400, body: { error: `"keys" is not a valid regular expression: ${err.message}` } };
        }
        keys = keys.filter(k => matcher.test(k));
    }

    const total = keys.length;
    const countOnly = source.count === true || source.count === 'true' || source.count === '1';
    if (countOnly) return { status: 200, body: { total } };

    const start = offset || 0;
    const page = limit === undefined ? keys.slice(start) : keys.slice(start, start + limit);

    const body = { total, keys: page };
    if (start > 0 || limit !== undefined) {
        body.offset = start;
        if (limit !== undefined) body.limit = limit;
        body.truncated = start + page.length < total;
    }
    return { status: 200, body };
}

/** Deterministic keyspace for the listing tests. */
const SAMPLE_KEYS = [
    'users.alice', 'users.bob', 'users.carol',
    'reports.2026.q1', 'reports.2026.q2', 'reports.2026.q3',
    'public.notice', 'public.terms',
];

/**
 * @param isAdmin         whether the caller passes the admin guard
 * @param accessFileValid whether reload-access accepts the file on disk
 */
function createServer({ keyListLimit, isAdmin = true, accessFileValid = true } = {}) {
    const nextToken = tokenSeries();
    const state = { lastRequest: null, requests: [] };
    // Versioned documents for the conditional-request tests, keyed by path.
    const docs = new Map();

    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const body = Buffer.concat(chunks);
            const record = {
                url: req.url,
                method: req.method,
                headers: req.headers,
                body,
                text: body.toString('utf8'),
            };
            state.lastRequest = record;
            state.requests.push(record);

            const send = (status, headers, payload) => {
                res.writeHead(status, headers);
                res.end(payload);
            };

            // --- auth -----------------------------------------------------
            if (req.url.startsWith('/auth/login')) {
                // Deliberately credential-free: whatever is posted logs in.
                return send(200, { 'Content-Type': 'application/json' },
                    JSON.stringify({ token: FAKE_TOKEN, user: { id: 'test-user', groups: ['testers'] } }));
            }

            // --- identity / build info ------------------------------------
            if (req.url.startsWith('/version')) {
                return send(200, { 'Content-Type': 'application/json', 'X-Renewed-Token': nextToken() },
                    JSON.stringify({ version: '9.9.9-test' }));
            }
            if (req.url.startsWith('/whoami')) {
                const url = new URL(req.url, 'http://localhost');
                const requested = (url.searchParams.get('keys') || '')
                    .split(',').map(k => k.trim()).filter(Boolean);
                const payload = {
                    version: '9.9.9-test',
                    authenticated: true,
                    user: { id: 'test-user', email: 'test-user@example.invalid' },
                    groups: ['testers'],
                    isAdmin: false,
                    rules: [{ group: 'testers', regex: '^public\\.', crudx: '11110' }],
                    rulesAreAdvisory: true,
                };
                if (requested.length) {
                    payload.permissions = {};
                    for (const key of requested) {
                        // Anything under public. is readable; nothing else is.
                        const allowed = key.startsWith('public.');
                        payload.permissions[key] =
                            { C: allowed, R: allowed, U: allowed, D: allowed, X: false };
                    }
                }
                return send(200, { 'Content-Type': 'application/json', 'X-Renewed-Token': nextToken() },
                    JSON.stringify(payload));
            }

            // --- canned responses used by individual tests ----------------
            if (req.url.startsWith('/__/401')) {
                // No X-Renewed-Token here, matching the real server.
                return send(401, { 'Content-Type': 'application/json' },
                    JSON.stringify({ error: 'Invalid authentication' }));
            }
            if (req.url.startsWith('/__/500')) {
                return send(500, { 'Content-Type': 'application/json' },
                    JSON.stringify({ error: 'Internal Server Error' }));
            }
            if (req.url.startsWith('/__/text')) {
                return send(200, { 'Content-Type': 'text/plain' }, 'plain text body');
            }
            if (req.url.startsWith('/__/empty')) {
                return send(204, {});
            }
            if (req.url.startsWith('/__/legacy')) {
                // An older server: never sends X-Renewed-Token.
                return send(200, { 'Content-Type': 'application/json' },
                    JSON.stringify({ legacy: true }));
            }
            if (req.url.startsWith('/__/hang')) {
                return; // never responds, for the timeout test
            }

            // --- admin router ---------------------------------------------
            if (req.url.startsWith('/admin/')) {
                const headers = { 'Content-Type': 'application/json', 'X-Renewed-Token': nextToken() };
                // The guard the real router installs before every admin route.
                if (!isAdmin) {
                    return send(403, headers, JSON.stringify({ error: 'Admin access required' }));
                }
                const path = req.url.split('?')[0];

                if (path === '/admin/keys') {
                    const source = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams.entries());
                    const result = listKeys(source, SAMPLE_KEYS, keyListLimit);
                    return send(result.status, headers, JSON.stringify(result.body));
                }
                if (path === '/admin/health') {
                    return send(200, headers, JSON.stringify({
                        uptime: 1234.5,
                        storage: {
                            indexedKeys: SAMPLE_KEYS.length,
                            disk: { totalBytes: 1000, freeBytes: 400, usedBytes: 600 },
                        },
                        modifications: 42,
                    }));
                }
                if (path.startsWith('/admin/modifications/')) {
                    const since = parseInt(path.slice('/admin/modifications/'.length), 10);
                    const all = [
                        { key: 'users.alice', modCount: 41, modified: 1, operation: 'PUT' },
                        { key: 'users.bob', modCount: 42, modified: 2, operation: 'POST' },
                    ];
                    return send(200, headers, JSON.stringify({
                        latestModCount: 42,
                        changes: all.filter(c => c.modCount > since),
                    }));
                }
                if (path === '/admin/rebuild-index' && req.method === 'POST') {
                    return send(200, headers, JSON.stringify({ status: 'success' }));
                }
                if (path === '/admin/rotate-index' && req.method === 'POST') {
                    return send(200, headers, JSON.stringify({ status: 'success', rotatedEntries: 8 }));
                }
                if (path === '/admin/reload-access' && req.method === 'POST') {
                    if (!accessFileValid) {
                        return send(400, headers, JSON.stringify({
                            error: 'access_file was rejected',
                            problems: [
                                'access_file: user "ghost" references unknown group "editors"',
                                'access_file: user "ghost" has no password',
                            ],
                        }));
                    }
                    return send(200, headers, JSON.stringify({ status: 'success', users: 3, groups: 2 }));
                }
                if (path === '/admin/logs') {
                    // One array per day file, newest first - the real shape.
                    return send(200, headers, JSON.stringify([
                        [{ ts: 'today-1', op: 'GET' }, { ts: 'today-2', op: 'PUT' }],
                        [{ ts: 'yesterday-1', op: 'POST' }],
                    ]));
                }
                return send(404, headers, JSON.stringify({ error: 'Not found' }));
            }

            // --- key listing ----------------------------------------------
            if (req.url.split('?')[0].replace(/\/$/, '') === '/cmd/keys') {
                const url = new URL(req.url, 'http://localhost');
                const source = Object.fromEntries(url.searchParams.entries());
                const result = listKeys(source, SAMPLE_KEYS, keyListLimit);
                return send(result.status,
                    { 'Content-Type': 'application/json', 'X-Renewed-Token': nextToken() },
                    JSON.stringify(result.body));
            }

            // --- versioned keys, for conditional requests -----------------
            if (req.url.startsWith('/keys/__versioned')) {
                const path = req.url.split('?')[0];
                const doc = docs.get(path);
                const currentEtag = etagFor(doc);
                const headers = { 'Content-Type': 'application/json', 'X-Renewed-Token': nextToken() };
                if (currentEtag !== null) headers['ETag'] = currentEtag;

                // Preconditions, evaluated the way the server does: If-Match
                // first, and the ETag goes out even on the 412.
                const ifMatch = req.headers['if-match'];
                const ifNoneMatch = req.headers['if-none-match'];
                if (ifMatch !== undefined) {
                    if (!etagMatches(ifMatch, currentEtag)) {
                        return send(412, headers, JSON.stringify({
                            error: 'Precondition failed: the key has changed since the version supplied in If-Match',
                            expected: ifMatch,
                            current: currentEtag,
                        }));
                    }
                } else if (ifNoneMatch !== undefined && etagMatches(ifNoneMatch, currentEtag)) {
                    // RFC 9110 13.1.2, and what the server does: on a read a
                    // match means "your copy is current" -> 304 with no body;
                    // 412 only for the methods where it is a write precondition.
                    if (req.method === 'GET' || req.method === 'HEAD') {
                        // A 304 carries no body, so no Content-Type either -
                        // only the validator and the renewed token.
                        const { 'Content-Type': _dropped, ...rest } = headers;
                        res.writeHead(304, rest);
                        return res.end();
                    }
                    return send(412, headers, JSON.stringify({
                        error: 'Precondition failed: the key matches If-None-Match',
                        current: currentEtag,
                    }));
                }

                if (req.method === 'GET') {
                    if (doc === undefined) return send(404, headers, JSON.stringify({ error: 'Not found' }));
                    return send(200, headers, JSON.stringify(doc.value));
                }
                if (req.method === 'PUT' || req.method === 'POST') {
                    const next = {
                        value: record.text ? JSON.parse(record.text) : null,
                        _modCounter: (doc?._modCounter || 0) + 1,
                    };
                    docs.set(path, next);
                    // The ETag of the version just written.
                    headers['ETag'] = etagFor(next);
                    return send(req.method === 'POST' ? 201 : 200, headers, JSON.stringify({ ok: 'success' }));
                }
                if (req.method === 'DELETE') {
                    docs.delete(path);
                    return send(200, headers, JSON.stringify({ ok: 'deleted' }));
                }
            }

            // --- normal echo, with a renewed token ------------------------
            const headers = { 'X-Renewed-Token': nextToken() };
            if (req.url.includes('binary=true')) {
                headers['Content-Type'] = 'application/octet-stream';
                return send(200, headers, Buffer.from([0xde, 0xad, 0xbe, 0xef]));
            }
            headers['Content-Type'] = 'application/json';
            send(200, headers, JSON.stringify({
                echo: {
                    url: req.url,
                    method: req.method,
                    authorization: req.headers.authorization || null,
                    contentType: req.headers['content-type'] || null,
                    body: record.text,
                }
            }));
        });
    });

    return {
        state,
        /** Simulates another client writing the key, bumping its version. */
        bump(path, value = { by: 'another client' }) {
            const doc = docs.get(path);
            docs.set(path, { value, _modCounter: (doc?._modCounter || 0) + 1 });
            return etagFor(docs.get(path));
        },
        docs,
        get lastRequest() { return state.lastRequest; },
        listen: () => new Promise(resolve =>
            server.listen(0, () => resolve(`http://127.0.0.1:${server.address().port}`))),
        close: () => new Promise(resolve => server.close(resolve)),
    };
}

module.exports = { createServer, FAKE_TOKEN, SAMPLE_KEYS };
