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

function createServer() {
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

module.exports = { createServer, FAKE_TOKEN };
