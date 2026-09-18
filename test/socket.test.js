// Realtime behaviour: the built-in socket.io v4 protocol client, exercised
// against a stub socket.io server (test/helpers/socketio-server.js).
//
// Needs a global WebSocket: built in from Node 22, and on Node 18-21 the
// npm test script adds --experimental-websocket automatically.
'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { DeepJSONSocket, SyncConnector } = require('../src/deepjson-connector.js');
const { createSocketIOServer, acceptKey } = require('./helpers/socketio-server.js');

const hasWebSocket = typeof WebSocket !== 'undefined';
const skip = hasWebSocket
    ? false
    : 'no global WebSocket (Node 22+, or run node with --experimental-websocket)';

/** Polls until `predicate()` is true, or rejects after `ms`. */
async function waitUntil(predicate, ms = 3000, label = 'condition') {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise(r => setTimeout(r, 20));
    }
    throw new Error(`timed out waiting for ${label}`);
}

/** Resolves on the next occurrence of `event`, or rejects after `ms`. */
function once(emitter, event, ms = 4000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms);
        emitter.on(event, (payload) => { clearTimeout(timer); resolve(payload); });
    });
}

describe('handshake helper', () => {
    test('the RFC 6455 accept key matches the published test vector', () => {
        assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    });
});

describe('DeepJSONSocket', { skip }, () => {
    let server, baseURL, connections;

    before(async () => {
        connections = [];
        server = createSocketIOServer((socket, query) => {
            connections.push({ socket, query });
            if (query.token === 'bad-token') {
                socket.emit('error', { code: 'AUTH_FAILED', message: 'Invalid authentication' });
                return socket.close();
            }
            if (query.action === 'create') {
                socket.emit('session-created', { channelId: 'test-channel' });
            } else if (query.action === 'connect') {
                socket.emit('session-joined', { channelId: query.channelId, isMaster: false });
            }
            socket.on('message', (payload) => {
                // Relay to every other client, as the real server does.
                for (const other of server.clients) {
                    if (other !== socket) other.emit('message', payload);
                }
            });
        });
        baseURL = await server.listen();
    });
    after(async () => { await server.close(); });

    test('completes the handshake and reports connected', async () => {
        const socket = new DeepJSONSocket(baseURL, { query: { token: 'test-token', action: 'create' } });
        await once(socket, 'connect');
        assert.equal(socket.connected, true);
        socket.disconnect();
    });

    test('passes the handshake query to the server', async () => {
        const socket = new DeepJSONSocket(baseURL, {
            query: { token: 'test-token', action: 'connect', channelId: 'abc' }
        });
        await once(socket, 'session-joined');
        const seen = connections[connections.length - 1].query;
        assert.equal(seen.token, 'test-token');
        assert.equal(seen.action, 'connect');
        assert.equal(seen.channelId, 'abc');
        socket.disconnect();
    });

    test('receives server events with their payload', async () => {
        const socket = new DeepJSONSocket(baseURL, { query: { token: 'test-token', action: 'create' } });
        assert.deepEqual(await once(socket, 'session-created'), { channelId: 'test-channel' });
        socket.disconnect();
    });

    test('emits events the server can read', async () => {
        const a = new DeepJSONSocket(baseURL, { query: { token: 'test-token', action: 'create' } });
        const b = new DeepJSONSocket(baseURL, { query: { token: 'test-token', action: 'create' } });
        await Promise.all([once(a, 'connect'), once(b, 'connect')]);

        const relayed = once(b, 'message');
        a.emit('message', { type: 'ping', data: { n: 1 } });
        assert.deepEqual(await relayed, { type: 'ping', data: { n: 1 } });

        a.disconnect(); b.disconnect();
    });

    test('surfaces an authentication failure as an error event', async () => {
        const socket = new DeepJSONSocket(baseURL, {
            query: { token: 'bad-token', action: 'create' }, reconnection: false
        });
        assert.deepEqual(await once(socket, 'error'),
            { code: 'AUTH_FAILED', message: 'Invalid authentication' });
        socket.disconnect();
    });

    test('off() removes a handler', async () => {
        const socket = new DeepJSONSocket(baseURL, { query: { token: 'test-token', action: 'create' } });
        await once(socket, 'connect');
        let calls = 0;
        const handler = () => { calls++; };
        socket.on('message', handler);
        socket.off('message', handler);
        socket.emit('message', { type: 'x', data: null });
        await new Promise(r => setTimeout(r, 150));
        assert.equal(calls, 0);
        socket.disconnect();
    });

    test('answers a server ping with a pong', async () => {
        // engine.io drops a connection that stops answering pings, so a
        // long-lived session depends on this even though a short test
        // would never see a ping otherwise.
        const socket = new DeepJSONSocket(baseURL, { query: { token: 'test-token', action: 'create' } });
        await once(socket, 'connect');
        const serverSide = connections[connections.length - 1].socket;

        serverSide.ping();
        await waitUntil(() => serverSide.frames.includes('3'), 3000, 'a pong frame');

        assert.equal(socket.connected, true, 'still connected after the exchange');
        socket.disconnect();
    });

    test('disconnect() clears the connected flag', async () => {
        const socket = new DeepJSONSocket(baseURL, { query: { token: 'test-token', action: 'create' } });
        await once(socket, 'connect');
        socket.disconnect();
        assert.equal(socket.connected, false);
    });

    test('reports a missing WebSocket implementation clearly', () => {
        const saved = globalThis.WebSocket;
        try {
            globalThis.WebSocket = undefined;
            assert.throws(
                () => new DeepJSONSocket(baseURL, { query: {} }),
                /No WebSocket implementation/
            );
        } finally {
            globalThis.WebSocket = saved;
        }
    });

    test('accepts an injected WebSocket implementation', () => {
        const saved = globalThis.WebSocket;
        try {
            globalThis.WebSocket = undefined;
            let constructedWith = null;
            class FakeWS {
                constructor(url) { constructedWith = url; this.readyState = 0; }
                close() {}
            }
            const socket = new DeepJSONSocket(baseURL, {
                query: { token: 'test-token' }, WebSocket: FakeWS, reconnection: false
            });
            assert.match(constructedWith, /^ws:\/\//, 'http baseURL became a ws:// URL');
            assert.match(constructedWith, /EIO=4&transport=websocket/);
            assert.match(constructedWith, /token=test-token/);
            socket.disconnect();
        } finally {
            globalThis.WebSocket = saved;
        }
    });
});

describe('SyncConnector', { skip }, () => {
    let server, baseURL;

    before(async () => {
        server = createSocketIOServer((socket, query) => {
            if (query.action === 'create') socket.emit('session-created', { channelId: 'test-channel' });
            if (query.action === 'connect') socket.emit('session-joined', { channelId: query.channelId });
            socket.on('message', (payload) => {
                for (const other of server.clients) if (other !== socket) other.emit('message', payload);
            });
        });
        baseURL = await server.listen();
    });
    after(async () => { await server.close(); });

    test('createSession resolves with the channel id', async () => {
        const sync = new SyncConnector({ baseURL, token: 'test-token' });
        assert.equal(await sync.createSession(), 'test-channel');
        sync.disconnect();
    });

    test('joinSession resolves with the session data', async () => {
        const sync = new SyncConnector({ baseURL, token: 'test-token' });
        const data = await sync.joinSession('some-channel');
        assert.equal(data.channelId, 'some-channel');
        sync.disconnect();
    });

    test('joinSession requires a channel id', async () => {
        const sync = new SyncConnector({ baseURL, token: 'test-token' });
        await assert.rejects(() => sync.joinSession(), /Channel ID required/);
    });

    test('send() before connecting is refused', () => {
        const sync = new SyncConnector({ baseURL, token: 'test-token' });
        assert.throws(() => sync.send('x', {}), /Not connected to a session/);
    });

    test('messages are forwarded to handlers registered by type', async () => {
        const a = new SyncConnector({ baseURL, token: 'test-token' });
        const b = new SyncConnector({ baseURL, token: 'test-token' });
        await a.createSession();
        await b.joinSession('test-channel');

        const received = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timed out')), 4000);
            b.on('canvas-update', (data) => { clearTimeout(timer); resolve(data); });
        });
        a.send('canvas-update', { x: 10, y: 20 });
        assert.deepEqual(await received, { x: 10, y: 20 });

        a.disconnect(); b.disconnect();
    });

    test('a renewed token reaches the handshake query for later reconnects', async () => {
        const sync = new SyncConnector({ baseURL, token: 'test-token' });
        await sync.createSession();
        sync.setToken('renewed-token');
        assert.equal(sync.socket.io.opts.query.token, 'renewed-token');
        sync.disconnect();
    });

    test('disconnect clears the socket and channel', async () => {
        const sync = new SyncConnector({ baseURL, token: 'test-token' });
        await sync.createSession();
        sync.disconnect();
        assert.equal(sync.socket, null);
        assert.equal(sync.currentChannel, null);
    });

    test('an injected io() factory is used instead of the built-in client', async () => {
        let used = false;
        const fakeSocket = {
            io: { opts: { query: {} } }, connected: false,
            on(event, cb) { if (event === 'session-created') setTimeout(() => cb({ channelId: 'injected' }), 0); return this; },
            off() { return this; }, emit() { return this; }, disconnect() { return this; },
        };
        const sync = new SyncConnector({
            baseURL, token: 'test-token',
            io: () => { used = true; return fakeSocket; }
        });
        assert.equal(await sync.createSession(), 'injected');
        assert.equal(used, true, 'the injected factory was called');
    });
});
