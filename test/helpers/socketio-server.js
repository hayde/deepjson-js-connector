// A throwaway socket.io v4 server for the tests, written on node:http and
// node:crypto alone so `npm test` needs no packages and works offline.
//
// It implements just enough of RFC 6455 (handshake + text frames) and of the
// engine.io / socket.io framing to exercise our client. It is a test double,
// not a server: no permessage-deflate, no fragmentation, no long-polling.
'use strict';

const http = require('http');
const crypto = require('crypto');

// RFC 6455 handshake GUID (verified against the spec's own test vector).
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function acceptKey(key) {
    return crypto.createHash('sha1').update(key + GUID).digest('base64');
}

/** Encodes one unmasked text frame (server -> client). */
function encodeFrame(text) {
    const payload = Buffer.from(text, 'utf8');
    const len = payload.length;
    let header;
    if (len < 126) {
        header = Buffer.from([0x81, len]);
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81; header[1] = 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81; header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    return Buffer.concat([header, payload]);
}

/** Pulls whole frames out of a buffer; client frames are always masked. */
function decodeFrames(buffer) {
    const out = [];
    let offset = 0;
    while (offset + 2 <= buffer.length) {
        const first = buffer[offset];
        const second = buffer[offset + 1];
        const opcode = first & 0x0f;
        const masked = (second & 0x80) === 0x80;
        let len = second & 0x7f;
        let cursor = offset + 2;

        if (len === 126) {
            if (cursor + 2 > buffer.length) break;
            len = buffer.readUInt16BE(cursor); cursor += 2;
        } else if (len === 127) {
            if (cursor + 8 > buffer.length) break;
            len = Number(buffer.readBigUInt64BE(cursor)); cursor += 8;
        }

        let mask = null;
        if (masked) {
            if (cursor + 4 > buffer.length) break;
            mask = buffer.subarray(cursor, cursor + 4); cursor += 4;
        }
        if (cursor + len > buffer.length) break;

        const payload = Buffer.from(buffer.subarray(cursor, cursor + len));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        cursor += len;

        out.push({ opcode, text: payload.toString('utf8') });
        offset = cursor;
    }
    return { frames: out, rest: buffer.subarray(offset) };
}

/**
 * Starts a fake socket.io server.
 * @param {(socket, query) => void} onConnection called once the socket.io
 *        CONNECT handshake completes; `socket.emit(event, payload)` sends,
 *        `socket.on(event, cb)` receives, `socket.close()` hangs up.
 */
function createSocketIOServer(onConnection) {
    const server = http.createServer((req, res) => {
        res.writeHead(426); res.end('upgrade required');
    });
    const clients = new Set();

    server.on('upgrade', (req, socket) => {
        const key = req.headers['sec-websocket-key'];
        if (!key) { socket.destroy(); return; }

        socket.write(
            'HTTP/1.1 101 Switching Protocols\r\n' +
            'Upgrade: websocket\r\n' +
            'Connection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
        );

        const query = Object.fromEntries(
            new URL(req.url, 'http://localhost').searchParams.entries()
        );

        const handlers = new Map();
        const api = {
            query,
            /** Every raw frame this client sent, for protocol-level assertions. */
            frames: [],
            raw: (text) => socket.write(encodeFrame(text)),
            /** Sends an engine.io PING; the client must answer with PONG. */
            ping() { api.raw('2'); },
            emit(event, payload) { api.raw('42' + JSON.stringify([event, payload])); },
            on(event, cb) { handlers.set(event, cb); },
            close() { try { socket.end(); } catch (e) { /* gone */ } },
        };
        clients.add(api);

        // engine.io OPEN
        api.raw('0' + JSON.stringify({
            sid: crypto.randomBytes(8).toString('hex'),
            upgrades: [], pingInterval: 25000, pingTimeout: 20000, maxPayload: 1000000
        }));

        let pending = Buffer.alloc(0);
        socket.on('data', (chunk) => {
            pending = Buffer.concat([pending, chunk]);
            const { frames, rest } = decodeFrames(pending);
            pending = rest;

            for (const frame of frames) {
                if (frame.opcode === 0x8) { api.close(); continue; }   // close
                if (frame.opcode !== 0x1) continue;                    // text only
                const text = frame.text;
                api.frames.push(text);

                if (text === '2') { api.raw('3'); continue; }          // ping -> pong
                if (text.startsWith('40')) {                           // socket.io CONNECT
                    api.raw('40' + JSON.stringify({ sid: crypto.randomBytes(8).toString('hex') }));
                    onConnection(api, query);
                    continue;
                }
                if (text.startsWith('41')) { api.close(); continue; }  // DISCONNECT
                if (text.startsWith('42')) {                           // EVENT
                    let parsed;
                    try { parsed = JSON.parse(text.slice(2)); } catch (e) { continue; }
                    const [name, ...args] = parsed;
                    const cb = handlers.get(name);
                    if (cb) cb(...args);
                }
            }
        });

        socket.on('error', () => { /* client vanished */ });
        socket.on('close', () => clients.delete(api));
    });

    return {
        server,
        clients,
        listen: () => new Promise(resolve =>
            server.listen(0, () => resolve(`http://127.0.0.1:${server.address().port}`))),
        close: () => new Promise(resolve => {
            for (const c of clients) c.close();
            server.close(resolve);
        }),
    };
}

module.exports = { createSocketIOServer, acceptKey, encodeFrame, decodeFrames, GUID };
