// src/core.js
//
// DeepJSON connector - zero runtime dependencies.
//
// Everything here runs on platform built-ins only (fetch, FormData, Blob,
// URL, WebSocket), so the package installs nothing and a browser can load it
// from a single <script> tag with no network access. See README "Offline use".

const _isNode = typeof process !== 'undefined' && process.versions?.node;

/** Mirrors the URL joining axios did for us: base + relative, one slash. */
function _isAbsoluteURL(url) {
    return /^([a-z][a-z\d+\-.]*:)?\/\//i.test(url);
}

function _buildFullPath(baseURL, requestedURL) {
    const url = requestedURL || '';
    if (!baseURL || _isAbsoluteURL(url)) return url;
    return baseURL.replace(/\/+$/, '') + '/' + url.replace(/^\/+/, '');
}

/** Appends query values, skipping null/undefined the way axios did. */
function _appendParams(url, params) {
    if (!params) return;
    for (const key of Object.keys(params)) {
        const value = params[key];
        if (value === null || value === undefined) continue;
        if (Array.isArray(value)) {
            value.forEach(v => url.searchParams.append(key, String(v)));
        } else {
            url.searchParams.append(key, String(value));
        }
    }
}

/** True for values we should JSON-encode rather than send verbatim. */
function _isPlainPayload(data) {
    if (data === null || typeof data !== 'object') return false;
    if (typeof FormData !== 'undefined' && data instanceof FormData) return false;
    if (typeof Blob !== 'undefined' && data instanceof Blob) return false;
    if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(data)) return false;
    if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) return false;
    return true;
}

export class DeepJSONConnector {
    constructor(config) {
        this.baseURL = config.baseURL;
        this.token = config.token || null;
        this.storage = config.storage || 'memory';
        this.timeout = config.timeout || 10000;

        // transmition options
        this.binary = false;
        this.overwriteKey = false;

        this.isNode = _isNode;

        // Extra headers sent on every request (documented in the README).
        this.headers = config.headers || {};

        // Called with the fresh token whenever the server renews it (sliding session)
        this.onTokenRenewed = typeof config.onTokenRenewed === 'function'
            ? config.onTokenRenewed
            : null;

        if (typeof fetch !== 'function') {
            throw new Error(
                'DeepJSONConnector requires a global fetch(). Use Node 18+ or a modern browser.'
            );
        }
    }

    // Authentication methods
    async login(username, password) {
        const data = await this._request({
            method: 'POST',
            uri: 'auth/login',
            headers: { 'Content-Type': 'application/json' },
            data: { username, password }
        });
        // The login response never carries X-Renewed-Token - the very first
        // token comes exclusively from the token field of its body.
        this.setToken(data.token);
        return data;
    }

    getToken() {
        return this.token;
    }

    // Sets the token used for subsequent requests. Use it to restore a token
    // that was persisted by the host application.
    setToken(token) {
        this.token = token || null;
        return this;
    }

    isBinary() {
        return this.binary;
    }
    setBinary(true_or_false) {
        this.binary = true_or_false
        return this;
    }
    isOverwriteKey() {
        return this.overwriteKey
    }
    setOverwriteKey(true_or_false) {
        this.overwriteKey = true_or_false;
        return this;
    }

    // Core CRUD operations
    async get(key, value = undefined, script = undefined) {
        const headers = {};
        const params = {};
        let httpMethod = "GET";
        if (value || script) {
            // here we 
            headers['X-Method-Override'] = "GET";
            httpMethod = "POST";
        }
        if (this.binary) {
            params.binary = true;
            params.token = this.token;
        }
        return this._request({
            method: httpMethod,
            uri: `/keys/${key}`,
            query: params,
            data: value,
            headers: headers,
            script: script
        });
    }

    async post(key, value, script = undefined) {
        const headers = {};
        if (this.overwriteKey) headers['X-Override-Existing'] = 'true';

        return this._request({
            method: 'POST',
            uri: `/keys/${key}`,
            query: null,
            data: value,
            headers: headers,
            script: script
        });
    }

    async put(key, value, script = undefined) {
        const headers = {};
        return this._request({
            method: 'PUT',
            uri: `/keys/${key}`,
            query: null,
            data: value,
            headers: headers,
            script: script
        });
    }

    async delete(key) {
        const headers = {};
        return this._request({
            method: 'DELETE',
            uri: `/keys/${key}`,
            query: null,
            data: null,
            headers: headers,
            script: null
        });
    }

    async move(key, key_to) {
        const headers = {};
        headers['Content-Type'] = "application/json; charset=utf-8";
        var value = { from: key, to: key_to };
        return this._request({
            method: 'POST',
            uri: `/cmd/move`,
            query: {},
            data: value,
            headers: headers
        });
    }

    // Universal file upload
    async uploadFile(key, file, options = {}) {
        const form = new FormData();

        if (this.isNode && typeof file === 'string') {
            // Node: wrap the file on disk in a Blob. openAsBlob keeps it backed
            // by the file instead of reading it all into memory.
            // webpackIgnore keeps these as real runtime imports: without it
            // webpack emits a second chunk file and a loader that fetches it,
            // which would break single-file <script> use offline.
            const fs = await import(/* webpackIgnore: true */ 'fs');
            const path = await import(/* webpackIgnore: true */ 'path');
            const blob = typeof fs.openAsBlob === 'function'
                ? await fs.openAsBlob(file)
                : new Blob([await fs.promises.readFile(file)]);
            form.append('file', blob, path.basename(file));
        } else {
            form.append('file', file, file.name);
        }

        return this._request({
            method: 'POST',
            uri: `/keys/${key}`,
            // Content-Type is deliberately left unset: the runtime has to add
            // the multipart boundary itself.
            headers: { 'X-Override-Existing': options.overwrite ? 'true' : 'false' },
            data: form
        });
    }

    // key list methods
    async listKeys(filters) {
        let tmp_filter = undefined;
        //check if filters is a regex or not
        if (filters) {
            if (filters.test) {
                // regex
                tmp_filter = filters.toString();
                // remove first and last char
                tmp_filter = tmp_filter.substring(1, tmp_filter.length - 1);
            } else {
                // string value
                tmp_filter = filters;
            }
        }
        return this._request({
            method: 'GET',
            uri: '/cmd/keys',
            query: { keys: tmp_filter }
        });
    }

    // Private methods
    async _request(config) {
        if (config.script && config.script.length > 0) {
            const payload =
                "javascript:\n" +
                config.script +
                "\n\njavascript!\n\n" +
                (typeof config.data === 'string'
                    ? config.data
                    : JSON.stringify(config.data, null, 2));
            config.data = payload;
        }

        const headers = {
            'Accept': 'application/json',
            ...this.headers,
            ...config.headers,
            ...(this.token && { 'Authorization': `Bearer ${this.token}` })
        };

        const isForm = typeof FormData !== 'undefined' && config.data instanceof FormData;
        let body;

        if (isForm) {
            body = config.data;
            // Let the runtime set multipart/form-data plus its boundary.
            for (const name of Object.keys(headers)) {
                if (name.toLowerCase() === 'content-type') delete headers[name];
            }
        } else if (config.data !== undefined && config.data !== null) {
            body = _isPlainPayload(config.data) ? JSON.stringify(config.data) : config.data;
            if (!Object.keys(headers).some(h => h.toLowerCase() === 'content-type')) {
                headers['Content-Type'] = 'text/plain; charset=utf-8';
            }
        }

        const wantsBinary = !!(config.query && config.query.binary);
        const method = (config.method || 'GET').toUpperCase();
        const url = new URL(
            _buildFullPath(this.baseURL, config.uri),
            typeof location !== 'undefined' ? location.href : undefined
        );
        _appendParams(url, config.query);

        this._resetFlags();

        // A body is meaningless on GET/HEAD and fetch rejects it outright.
        const init = { method, headers };
        if (body !== undefined && method !== 'GET' && method !== 'HEAD') init.body = body;

        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        let timer = null;
        if (controller) {
            init.signal = controller.signal;
            if (this.timeout > 0) timer = setTimeout(() => controller.abort(), this.timeout);
        }

        let response;
        try {
            response = await fetch(url.toString(), init);
        } catch (error) {
            if (error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
                const err = new Error('Network Error: No response from server');
                err.code = 'ETIMEDOUT';
                throw err;
            }
            throw new Error('Network Error: No response from server');
        } finally {
            if (timer) clearTimeout(timer);
        }

        this._applyRenewedToken(response);

        if (!response.ok) {
            const err = new Error(`API Error: ${response.status} ${response.statusText}`);
            err.status = response.status;
            err.details = await this._readBody(response, false);
            throw err;
        }

        return this._readBody(response, wantsBinary);
    }

    /** Decodes a response the way axios used to: JSON when it looks like JSON. */
    async _readBody(response, wantsBinary) {
        if (response.status === 204) return null;
        if (wantsBinary) return response.arrayBuffer();

        const type = response.headers.get('content-type') || '';
        if (type.includes('json')) {
            try {
                return await response.json();
            } catch (e) {
                return null;
            }
        }

        const text = await response.text();
        if (!text) return text;
        try {
            return JSON.parse(text);
        } catch (e) {
            return text;
        }
    }

    _resetFlags() {
        this.binary = false;
        this.overwriteKey = false;
    }

    // Adopts the token the server issued for the next request, if any.
    // Absent on the login response, on 401s and on HMAC device requests.
    _applyRenewedToken(response) {
        const headers = response && response.headers;
        if (!headers) return;

        const renewed = typeof headers.get === 'function'
            ? headers.get('x-renewed-token')
            : (headers['x-renewed-token'] || headers['X-Renewed-Token']);

        if (!renewed || renewed === this.token) return;

        this.setToken(renewed);
        if (this.onTokenRenewed) {
            try {
                this.onTokenRenewed(renewed);
            } catch (e) {
                // A failing consumer callback must never break the request.
            }
        }
    }

    _handleError(error) {
        if (error.response) {
            const err = new Error(`API Error: ${error.response.status} ${error.response.statusText}`);
            err.status = error.response.status;
            err.details = error.response.data;
            throw err;
        } else if (error.request) {
            throw new Error('Network Error: No response from server');
        } else {
            throw new Error(`Request Error: ${error.message}`);
        }
    }
}

// ── Minimal socket.io v4 client ──────────────────────────────────────
//
// The server speaks the socket.io protocol, so a bare WebSocket is not
// enough - but the slice we need is small. Engine.IO frames a packet as a
// single leading digit (0 open, 1 close, 2 ping, 3 pong, 4 message); a
// message then carries a Socket.IO packet, itself prefixed by a digit
// (0 CONNECT, 1 DISCONNECT, 2 EVENT, 4 CONNECT_ERROR). Auth travels in the
// handshake query, exactly as socket.io-client sends it.

const EIO = { OPEN: '0', CLOSE: '1', PING: '2', PONG: '3', MESSAGE: '4' };
const SIO = { CONNECT: 0, DISCONNECT: 1, EVENT: 2, ACK: 3, CONNECT_ERROR: 4 };

/** Parses "2/nsp,12[\"ev\",{}]" into its parts. */
function _decodePacket(str) {
    let i = 0;
    const type = Number(str[i++]);
    let nsp = '/';

    // optional binary attachment count, e.g. "51-[...]"
    const numStart = i;
    while (i < str.length && str[i] >= '0' && str[i] <= '9') i++;
    if (str[i] === '-') i++; else i = numStart;

    if (str[i] === '/') {
        const end = str.indexOf(',', i);
        if (end === -1) { nsp = str.slice(i); i = str.length; }
        else { nsp = str.slice(i, end); i = end + 1; }
    }

    const ackStart = i;
    while (i < str.length && str[i] >= '0' && str[i] <= '9') i++;
    const id = i > ackStart ? Number(str.slice(ackStart, i)) : undefined;

    let data;
    if (i < str.length) {
        try { data = JSON.parse(str.slice(i)); } catch (e) { data = undefined; }
    }
    return { type, nsp, id, data };
}

export class DeepJSONSocket {
    constructor(baseURL, opts = {}) {
        this.baseURL = baseURL;
        // Shaped like socket.io-client's manager so opts.query stays writable.
        this.io = { opts: { query: opts.query || {} } };
        this.path = opts.path || '/socket.io';
        this.connected = false;
        this.reconnection = opts.reconnection !== false;
        this.reconnectionDelay = opts.reconnectionDelay || 1000;
        this.reconnectionAttempts = opts.reconnectionAttempts || Infinity;

        this._handlers = new Map();
        this._buffer = [];
        this._ws = null;
        this._attempts = 0;
        this._closing = false;
        this._retryTimer = null;

        const WS = opts.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null);
        if (!WS) {
            throw new Error(
                'No WebSocket implementation available. Browsers and Node 22+ have one ' +
                'built in; on older Node run with --experimental-websocket or pass ' +
                '{ WebSocket } in the connector config.'
            );
        }
        this._WS = WS;
        this._open();
    }

    _url() {
        const url = new URL(
            this.path.replace(/^\/?/, '/') + '/',
            this.baseURL.replace(/\/+$/, '') + '/'
        );
        url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
        url.searchParams.set('EIO', '4');
        url.searchParams.set('transport', 'websocket');
        // Read the query fresh on every attempt so a renewed token is picked up.
        _appendParams(url, this.io.opts.query);
        return url.toString();
    }

    _open() {
        this._closing = false;
        let ws;
        try {
            ws = new this._WS(this._url());
        } catch (err) {
            this._scheduleRetry();
            return;
        }
        this._ws = ws;

        ws.onmessage = (event) => this._onFrame(typeof event.data === 'string' ? event.data : '');
        ws.onerror = () => { /* onclose always follows; retry is handled there */ };
        ws.onclose = () => {
            const wasConnected = this.connected;
            this.connected = false;
            this._ws = null;
            if (wasConnected) this._dispatch('disconnect', 'transport close');
            if (!this._closing) this._scheduleRetry();
        };
    }

    _scheduleRetry() {
        if (!this.reconnection || this._closing) return;
        if (this._attempts >= this.reconnectionAttempts) return;
        this._attempts++;
        const delay = Math.min(this.reconnectionDelay * this._attempts, 5000);
        this._retryTimer = setTimeout(() => this._open(), delay);
        if (typeof this._retryTimer.unref === 'function') this._retryTimer.unref();
    }

    _send(raw) {
        if (this._ws && this._ws.readyState === 1) this._ws.send(raw);
    }

    _onFrame(raw) {
        if (!raw) return;
        const kind = raw[0];
        const rest = raw.slice(1);

        if (kind === EIO.OPEN) {
            // Engine handshake done - now open the default Socket.IO namespace.
            this._send(EIO.MESSAGE + String(SIO.CONNECT));
            return;
        }
        if (kind === EIO.PING) { this._send(EIO.PONG); return; }
        if (kind === EIO.CLOSE) { this.disconnect(); return; }
        if (kind !== EIO.MESSAGE) return;

        const packet = _decodePacket(rest);

        if (packet.type === SIO.CONNECT) {
            this.connected = true;
            this._attempts = 0;
            this._dispatch('connect');
            const queued = this._buffer.splice(0);
            queued.forEach(raw => this._send(raw));
            return;
        }
        if (packet.type === SIO.CONNECT_ERROR) {
            this._dispatch('error', packet.data);
            return;
        }
        if (packet.type === SIO.DISCONNECT) {
            this.connected = false;
            this._dispatch('disconnect', 'io server disconnect');
            return;
        }
        if (packet.type === SIO.EVENT && Array.isArray(packet.data)) {
            const [name, ...args] = packet.data;
            this._dispatch(name, ...args);
        }
    }

    _dispatch(name, ...args) {
        const handlers = this._handlers.get(name);
        if (!handlers) return;
        handlers.slice().forEach(handler => handler(...args));
    }

    on(name, handler) {
        if (!this._handlers.has(name)) this._handlers.set(name, []);
        this._handlers.get(name).push(handler);
        return this;
    }

    off(name, handler) {
        const handlers = this._handlers.get(name);
        if (!handlers) return this;
        if (!handler) { this._handlers.delete(name); return this; }
        const index = handlers.indexOf(handler);
        if (index > -1) handlers.splice(index, 1);
        return this;
    }

    emit(name, ...args) {
        const raw = EIO.MESSAGE + String(SIO.EVENT) + JSON.stringify([name, ...args]);
        if (this.connected) this._send(raw);
        else this._buffer.push(raw);   // flushed once CONNECT lands
        return this;
    }

    disconnect() {
        this._closing = true;
        if (this._retryTimer) clearTimeout(this._retryTimer);
        if (this._ws) {
            if (this._ws.readyState === 1) this._send(EIO.MESSAGE + String(SIO.DISCONNECT));
            try { this._ws.close(); } catch (e) { /* already gone */ }
        }
        this._ws = null;
        this.connected = false;
        return this;
    }
}

export class DeepJSONSyncConnector extends DeepJSONConnector {
    constructor(config) {
        super(config);
        this.socket = null;
        this.sessionHandlers = new Map();
        this.currentChannel = null;

        // Escape hatches: pass `io` to use socket.io-client instead of the
        // built-in protocol client, or `WebSocket` to supply an implementation
        // on Node versions that have none (e.g. the 'ws' package).
        this._io = typeof config.io === 'function' ? config.io : null;
        this._WebSocket = config.WebSocket || null;
    }

    _createSocket(query) {
        if (this._io) return this._io(this.baseURL, { query });
        return new DeepJSONSocket(this.baseURL, { query, WebSocket: this._WebSocket });
    }

    // Session Management ======================================================
    async createSession() {
        if (this.socket) this.disconnect();

        this.socket = this._createSocket({
            token: this.token,
            action: 'create'
        });

        return new Promise((resolve, reject) => {
            this.socket.on('session-created', ({ channelId }) => {
                this.currentChannel = channelId;
                this._setupSocketListeners();
                resolve(channelId);
            });

            this.socket.on('error', reject);
        });
    }

    async joinSession(channelId) {
        if (!channelId) throw new Error('Channel ID required');
        if (this.socket) this.disconnect();

        this.socket = this._createSocket({
            token: this.token,
            action: 'connect',
            channelId: channelId
        });
        return new Promise((resolve, reject) => {
            this.socket.on('session-joined', (sessionData) => {
                this.currentChannel = channelId;
                this._setupSocketListeners();
                resolve(sessionData);
            });

            this.socket.on('error', reject);
        });
    }

    // Message Handling ========================================================
    on(eventName, callback) {
        if (!this.sessionHandlers.has(eventName)) {
            this.sessionHandlers.set(eventName, []);
        }
        this.sessionHandlers.get(eventName).push(callback);

        if (this.socket) {
            this.socket.on(eventName, callback);
        }
    }

    off(eventName, callback) {
        if (this.sessionHandlers.has(eventName)) {
            const handlers = this.sessionHandlers.get(eventName);
            const index = handlers.indexOf(callback);
            if (index > -1) handlers.splice(index, 1);
        }

        if (this.socket) {
            this.socket.off(eventName, callback);
        }
    }

    send(type, data) {
        if (!this.socket || !this.socket.connected) {
            throw new Error('Not connected to a session');
        }
        this.socket.emit('message', { type, data });
    }

    // Connection Management ===================================================
    disconnect() {
        if (this.socket) {
            this.socket.disconnect();
            this.socket = null;
            this.currentChannel = null;
        }
    }

    reconnect() {
        if (!this.currentChannel) return;
        return this.joinSession(this.currentChannel);
    }

    // Event Forwarding ========================================================
    _setupSocketListeners() {
        if (!this.socket) return;

        // Forward standard events
        const events = ['connect', 'disconnect', 'reconnect', 'reconnecting'];
        events.forEach(event => {
            this.socket.on(event, (...args) => {
                this.sessionHandlers.get(event)?.forEach(handler => handler(...args));
            });
        });

        // Forward custom messages
        this.socket.on('message', (payload) => {
            const handlers = this.sessionHandlers.get(payload.type) || [];
            handlers.forEach(handler => handler(payload.data));
        });
    }

    // Override setToken so a renewed token also reaches the socket handshake:
    // the handshake query is re-read on every reconnect attempt, and an open
    // connection is only authenticated once, when it is established.
    setToken(token) {
        super.setToken(token);
        if (this.socket && this.socket.io && this.socket.io.opts.query) {
            this.socket.io.opts.query.token = this.token;
        }
        return this;
    }

    // Override login to handle socket reauthentication
    async login(username, password) {
        const result = await super.login(username, password);
        if (this.socket) {
            this.reconnect();
        }
        return result;
    }
}

// Aliase + default — deckt alle Import-Stile ab
export const Connector     = DeepJSONConnector;
export const SyncConnector = DeepJSONSyncConnector;

export default {
  Connector,
  SyncConnector,
  DeepJSONConnector,
  DeepJSONSyncConnector,
};
