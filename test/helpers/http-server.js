// Stub DeepJSON HTTP server for the tests. It authenticates nothing: any
// username/password is accepted and the tokens are obvious fakes, so no real
// credentials ever appear in this repository.
'use strict';

const http = require('http');

const FAKE_TOKEN = 'test-token-initial';

/** Successive renewal tokens: test-token-1, test-token-2, ... */
function tokenSeries() {
    let n = 0;
    return () => `test-token-${++n}`;
}

function createServer() {
    const nextToken = tokenSeries();
    const state = { lastRequest: null, requests: [] };

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
        get lastRequest() { return state.lastRequest; },
        listen: () => new Promise(resolve =>
            server.listen(0, () => resolve(`http://127.0.0.1:${server.address().port}`))),
        close: () => new Promise(resolve => server.close(resolve)),
    };
}

module.exports = { createServer, FAKE_TOKEN };
