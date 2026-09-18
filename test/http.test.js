// HTTP behaviour of the connector, against a stub DeepJSON server.
// Run with: npm test
'use strict';

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Connector } = require('../src/deepjson-connector.js');
const { createServer, FAKE_TOKEN } = require('./helpers/http-server.js');

let server, baseURL;

before(async () => {
    server = createServer();
    baseURL = await server.listen();
});
after(async () => { await server.close(); });

/** A connector pointed at the stub, already logged in unless told otherwise. */
async function connected(extra = {}) {
    const dj = new Connector({ baseURL, ...extra });
    await dj.login('any-user', 'any-password');
    return dj;
}

describe('authentication', () => {
    test('login stores the token and returns the body', async () => {
        const dj = new Connector({ baseURL });
        const result = await dj.login('any-user', 'any-password');
        assert.equal(result.user.id, 'test-user');
        assert.equal(dj.getToken(), FAKE_TOKEN);
    });

    test('login posts JSON', async () => {
        const dj = new Connector({ baseURL });
        await dj.login('someone', 'secret-not-real');
        assert.equal(server.lastRequest.headers['content-type'], 'application/json');
        assert.deepEqual(JSON.parse(server.lastRequest.text),
            { username: 'someone', password: 'secret-not-real' });
    });

    test('setToken restores a persisted token', async () => {
        const dj = new Connector({ baseURL });
        assert.equal(dj.setToken('restored-token'), dj, 'is chainable');
        await dj.get('some.key');
        assert.equal(server.lastRequest.headers.authorization, 'Bearer restored-token');
    });

    test('an anonymous connector sends no Authorization header', async () => {
        const dj = new Connector({ baseURL });
        await dj.get('public.key');
        assert.equal(server.lastRequest.headers.authorization, undefined);
    });

    test('assigning .token directly still works (1.x style)', async () => {
        const dj = new Connector({ baseURL });
        dj.token = 'directly-assigned';
        await dj.get('some.key');
        assert.equal(server.lastRequest.headers.authorization, 'Bearer directly-assigned');
    });
});

describe('sliding session (X-Renewed-Token)', () => {
    test('each response swaps in the token for the next request', async () => {
        const dj = await connected();
        assert.equal(dj.getToken(), FAKE_TOKEN);

        await dj.get('a');
        const first = dj.getToken();
        assert.notEqual(first, FAKE_TOKEN, 'token was renewed');
        assert.equal(server.lastRequest.headers.authorization, `Bearer ${FAKE_TOKEN}`,
            'the request itself still used the previous token');

        await dj.get('b');
        assert.equal(server.lastRequest.headers.authorization, `Bearer ${first}`,
            'the next request used the renewed token');
        assert.notEqual(dj.getToken(), first, 'and was renewed again');
    });

    test('renewal happens on every verb', async () => {
        const dj = await connected();
        const seen = new Set([dj.getToken()]);
        await dj.get('k');    seen.add(dj.getToken());
        await dj.post('k', { a: 1 }); seen.add(dj.getToken());
        await dj.put('k', { a: 2 });  seen.add(dj.getToken());
        await dj.delete('k');         seen.add(dj.getToken());
        await dj.listKeys();          seen.add(dj.getToken());
        assert.equal(seen.size, 6, 'six distinct tokens: initial plus one per call');
    });

    test('onTokenRenewed fires with each new token', async () => {
        const renewals = [];
        const dj = await connected({ onTokenRenewed: t => renewals.push(t) });
        await dj.get('a');
        await dj.get('b');
        assert.equal(renewals.length, 2);
        assert.equal(renewals[1], dj.getToken());
    });

    test('a throwing onTokenRenewed callback does not break the request', async () => {
        const dj = await connected({ onTokenRenewed: () => { throw new Error('consumer bug'); } });
        const result = await dj.get('a');
        assert.ok(result.echo, 'request still returned normally');
    });

    test('no callback is fired and no token changes on a 401', async () => {
        const renewals = [];
        const dj = await connected({ onTokenRenewed: t => renewals.push(t) });
        const before = dj.getToken();
        await assert.rejects(() => dj.get('../__/401'));
        assert.equal(dj.getToken(), before, 'token untouched');
        assert.equal(renewals.length, 0);
    });

    test('an older server that never sends the header keeps working', async () => {
        const renewals = [];
        const dj = await connected({ onTokenRenewed: t => renewals.push(t) });
        const before = dj.getToken();
        const result = await dj.get('../__/legacy');
        assert.deepEqual(result, { legacy: true });
        assert.equal(dj.getToken(), before, 'token unchanged, as in 1.x');
        assert.equal(renewals.length, 0);
    });
});

describe('CRUD', () => {
    test('get issues a plain GET with no body', async () => {
        const dj = await connected();
        await dj.get('users.123');
        assert.equal(server.lastRequest.method, 'GET');
        assert.equal(server.lastRequest.url, '/keys/users.123');
        assert.equal(server.lastRequest.body.length, 0);
    });

    test('get with a value becomes POST + X-Method-Override', async () => {
        const dj = await connected();
        await dj.get('users.123', { filter: 1 });
        assert.equal(server.lastRequest.method, 'POST');
        assert.equal(server.lastRequest.headers['x-method-override'], 'GET');
    });

    test('objects are sent as JSON text', async () => {
        const dj = await connected();
        await dj.post('users.123', { name: 'Test' });
        assert.equal(server.lastRequest.text, '{"name":"Test"}');
        assert.equal(server.lastRequest.headers['content-type'], 'text/plain; charset=utf-8');
    });

    test('strings are sent verbatim', async () => {
        const dj = await connected();
        await dj.post('users.123', 'a raw string');
        assert.equal(server.lastRequest.text, 'a raw string');
    });

    test('put and delete hit the right route', async () => {
        const dj = await connected();
        await dj.put('users.123', { role: 'admin' });
        assert.equal(server.lastRequest.method, 'PUT');
        await dj.delete('users.123');
        assert.equal(server.lastRequest.method, 'DELETE');
        assert.equal(server.lastRequest.url, '/keys/users.123');
    });

    test('move posts from/to as JSON', async () => {
        const dj = await connected();
        await dj.move('a.old', 'a.new');
        assert.equal(server.lastRequest.url, '/cmd/move');
        assert.equal(server.lastRequest.headers['content-type'], 'application/json; charset=utf-8');
        assert.deepEqual(JSON.parse(server.lastRequest.text), { from: 'a.old', to: 'a.new' });
    });

    test('listKeys converts a RegExp to a bare pattern', async () => {
        const dj = await connected();
        await dj.listKeys(/^users\./);
        assert.equal(decodeURIComponent(server.lastRequest.url), '/cmd/keys?keys=^users\\.');
    });

    test('listKeys without a filter sends no query', async () => {
        const dj = await connected();
        await dj.listKeys();
        assert.equal(server.lastRequest.url, '/cmd/keys');
    });
});

describe('flags', () => {
    test('setOverwriteKey adds the header and resets afterwards', async () => {
        const dj = await connected();
        assert.equal(dj.setOverwriteKey(true), dj, 'is chainable');
        await dj.post('k', { a: 1 });
        assert.equal(server.lastRequest.headers['x-override-existing'], 'true');
        assert.equal(dj.isOverwriteKey(), false, 'reset after the request');
    });

    test('setBinary returns an ArrayBuffer and resets afterwards', async () => {
        const dj = await connected();
        dj.setBinary(true);
        const buf = await dj.get('photo.jpg');
        assert.ok(buf instanceof ArrayBuffer, 'got an ArrayBuffer');
        assert.deepEqual([...new Uint8Array(buf)], [0xde, 0xad, 0xbe, 0xef]);
        assert.equal(dj.isBinary(), false, 'reset after the request');
    });

    test('binary requests carry the token in the query too', async () => {
        const dj = await connected();
        dj.setBinary(true);
        await dj.get('photo.jpg');
        assert.match(server.lastRequest.url, /binary=true/);
        assert.match(server.lastRequest.url, /token=/);
    });
});

describe('scripts', () => {
    test('a script is wrapped in the javascript: / javascript! envelope', async () => {
        const dj = await connected();
        await dj.post('data.process', { v: 1 }, 'response = 1;');
        assert.equal(server.lastRequest.text,
            'javascript:\nresponse = 1;\n\njavascript!\n\n' + JSON.stringify({ v: 1 }, null, 2));
    });

    test('a string payload is not re-encoded', async () => {
        const dj = await connected();
        await dj.post('data.process', 'raw', 'response = 1;');
        assert.equal(server.lastRequest.text, 'javascript:\nresponse = 1;\n\njavascript!\n\nraw');
    });
});

describe('responses', () => {
    test('text/plain comes back as a string', async () => {
        const dj = await connected();
        assert.equal(await dj.get('../__/text'), 'plain text body');
    });

    test('204 comes back as null', async () => {
        const dj = await connected();
        assert.equal(await dj.get('../__/empty'), null);
    });
});

describe('errors', () => {
    test('401 carries status and details', async () => {
        const dj = await connected();
        await assert.rejects(() => dj.get('../__/401'), (err) => {
            assert.equal(err.message, 'API Error: 401 Unauthorized');
            assert.equal(err.status, 401);
            assert.deepEqual(err.details, { error: 'Invalid authentication' });
            return true;
        });
    });

    test('500 carries status and details', async () => {
        const dj = await connected();
        await assert.rejects(() => dj.get('../__/500'), (err) => {
            assert.equal(err.status, 500);
            assert.deepEqual(err.details, { error: 'Internal Server Error' });
            return true;
        });
    });

    test('an unreachable server is a network error', async () => {
        const dj = new Connector({ baseURL: 'http://127.0.0.1:1/' });
        await assert.rejects(() => dj.get('k'),
            { message: 'Network Error: No response from server' });
    });

    test('a hanging request times out', async () => {
        const dj = new Connector({ baseURL, timeout: 250 });
        const started = Date.now();
        await assert.rejects(() => dj.get('../__/hang'), (err) => {
            assert.equal(err.message, 'Network Error: No response from server');
            assert.equal(err.code, 'ETIMEDOUT');
            return true;
        });
        assert.ok(Date.now() - started < 2000, 'gave up promptly');
    });
});

describe('configuration', () => {
    test('baseURL joins correctly with and without a trailing slash', async () => {
        for (const base of [baseURL, baseURL + '/']) {
            const dj = new Connector({ baseURL: base });
            await dj.get('a.b');
            assert.equal(server.lastRequest.url, '/keys/a.b', `for baseURL ${base}`);
        }
    });

    test('config.headers are sent on every request', async () => {
        const dj = new Connector({ baseURL, headers: { 'X-Client-Version': '2.0.0' } });
        await dj.get('a');
        assert.equal(server.lastRequest.headers['x-client-version'], '2.0.0');
    });

    test('a missing fetch is reported clearly', () => {
        const saved = globalThis.fetch;
        try {
            globalThis.fetch = undefined;
            assert.throws(() => new Connector({ baseURL }), /requires a global fetch/);
        } finally {
            globalThis.fetch = saved;
        }
    });
});

describe('uploadFile', () => {
    let tmpFile;
    beforeEach(() => {
        tmpFile = path.join(os.tmpdir(), `deepjson-test-${process.pid}.txt`);
        fs.writeFileSync(tmpFile, 'uploaded file contents');
    });
    after(() => { try { fs.unlinkSync(tmpFile); } catch (e) { /* already gone */ } });

    test('sends multipart/form-data with a boundary', async () => {
        const dj = await connected();
        await dj.uploadFile('docs/report.txt', tmpFile);
        const contentType = server.lastRequest.headers['content-type'];
        assert.match(contentType, /^multipart\/form-data/);
        assert.match(contentType, /boundary=/);
    });

    test('uses the field name and filename the server expects', async () => {
        const dj = await connected();
        await dj.uploadFile('docs/report.txt', tmpFile);
        assert.match(server.lastRequest.text, /name="file"/);
        assert.match(server.lastRequest.text, /deepjson-test-\d+\.txt/);
        assert.match(server.lastRequest.text, /uploaded file contents/);
    });

    test('passes the overwrite flag through', async () => {
        const dj = await connected();
        await dj.uploadFile('docs/report.txt', tmpFile, { overwrite: true });
        assert.equal(server.lastRequest.headers['x-override-existing'], 'true');
        await dj.uploadFile('docs/report.txt', tmpFile);
        assert.equal(server.lastRequest.headers['x-override-existing'], 'false');
    });
});
