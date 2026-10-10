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

/**
 * Normalises a key filter to the pattern string the server compiles.
 *
 * A RegExp contributes its `source`: stringifying and slicing off the first
 * and last character - what this used to do - mangles any regex carrying
 * flags, turning /^users\./i into "^users\./" and matching the wrong thing
 * with no error. Flags themselves cannot be honoured: the server builds
 * `new RegExp(pattern)` with none, so they are dropped rather than smuggled in.
 */
function _patternFrom(filters) {
    if (filters === undefined || filters === null || filters === '') return undefined;
    if (typeof filters.source === 'string') return filters.source;   // RegExp, incl. cross-realm
    return String(filters);
}

/**
 * Image modulation parameters the server understands (see
 * _hasImageModulation): anything else is a typo rather than a feature, and
 * silently dropping it would mean no resize and no error.
 */
const _IMAGE_PARAMS = [
    'width', 'height', 'fit', 'alignX', 'alignY', 'allowEnlarge', 'format', 'quality'
];

function _imageParams(options) {
    const out = {};
    if (!options) return out;
    for (const name of Object.keys(options)) {
        if (!_IMAGE_PARAMS.includes(name)) {
            throw new Error(
                `Unknown image option "${name}". Valid options: ${_IMAGE_PARAMS.join(', ')}`
            );
        }
        if (options[name] !== undefined && options[name] !== null) out[name] = options[name];
    }
    return out;
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

        // Conditional-request state. Both are one-shot, like the flags above:
        // consumed by the next request and then cleared.
        this.ifMatch = null;
        this.ifNoneMatch = null;

        // ETag of the most recent response, or null if it carried none.
        this.lastEtag = null;

        // One-shot image modulation for the next binary read.
        this.imageOptions = null;

        this.isNode = _isNode;

        // Extra headers sent on every request (documented in the README).
        this.headers = config.headers || {};

        // Called with the fresh token whenever the server renews it (sliding session)
        this.onTokenRenewed = typeof config.onTokenRenewed === 'function'
            ? config.onTokenRenewed
            : null;

        // Administrative operations, grouped so it is obvious at the call site
        // that they need an admin account and answer 403 otherwise. whoami()
        // reports isAdmin if you want to check before offering them in a UI.
        this.admin = this._createAdminAPI();

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

    // Identity and build info ================================================

    /**
     * GET /version - the server's build version. It sits behind the auth
     * middleware, so it answers three things at once: the server is up, the
     * token is still valid, and what is being talked to. Cheap enough to use
     * as a heartbeat, and the response renews the token like any other call.
     * Resolves with the response body, e.g. { version: '2.3.1' }.
     */
    async version() {
        return this._request({ method: 'GET', uri: '/version' });
    }

    /**
     * GET /whoami - the caller's identity, groups and admin flag.
     *
     * Pass one or more keys to have the server resolve the effective
     * permissions for them: whoami('reports.q3') or whoami(['a', 'b']) adds a
     * `permissions` map of { C, R, U, D, X } booleans per key.
     *
     * The response also carries a `rules` list, flagged `rulesAreAdvisory`.
     * It is for display and debugging only - never evaluate it to decide what
     * the user may do. The server applies rules in order with last-match-wins,
     * so the usual "any matching rule grants it" reading disagrees with the
     * server precisely where it matters. Ask for `permissions` instead; those
     * come from the same check that enforces on every request.
     */
    async whoami(keys = undefined) {
        const query = {};
        const requested = Array.isArray(keys) ? keys.join(',') : keys;
        if (requested) query.keys = requested;
        return this._request({ method: 'GET', uri: '/whoami', query });
    }

    isBinary() {
        return this.binary;
    }
    setBinary(true_or_false) {
        this.binary = true_or_false
        return this;
    }

    /**
     * Server-side image modulation for the next binary read, e.g.
     * setBinary(true).setImageOptions({ width: 800, format: 'jpeg' }).get(key)
     *
     * Valid options: width, height, fit, alignX, alignY, allowEnlarge, format,
     * quality. One-shot, like setBinary(). Throws on an unrecognised option
     * rather than quietly returning the unmodified image.
     */
    setImageOptions(options) {
        _imageParams(options);          // validate now, not at request time
        this.imageOptions = options || null;
        return this;
    }

    /**
     * Builds a direct, self-authenticating URL for a key's binary content -
     * the thing you hand to an <img src>, <a href>, <video src> or a new tab,
     * where no Authorization header can be set.
     *
     * The token travels in the query string, which is what makes the URL work
     * on its own. Two consequences worth designing around:
     *
     *  - It is a bearer credential in a URL. It lands in browser history,
     *    proxy and server logs, and any Referer header the page sends. Treat a
     *    generated URL as secret: do not log it, persist it, or paste it.
     *  - It stops working when the token expires - an hour from when that
     *    token was issued, not from when the URL was built. Build it at the
     *    point of use rather than caching it.
     *
     * Image modulation options are accepted here too, so a thumbnail can be
     * served straight into an <img> without fetching the full-size original.
     */
    getBinaryURL(key, options = {}) {
        if (!this.token) {
            throw new Error(
                'getBinaryURL() needs a token: the URL authenticates itself via ?token=. ' +
                'Call login() or setToken() first.'
            );
        }
        const url = new URL(
            _buildFullPath(this.baseURL, `/keys/${key}`),
            typeof location !== 'undefined' ? location.href : undefined
        );
        url.searchParams.set('binary', 'true');
        url.searchParams.set('token', this.token);
        _appendParams(url, _imageParams(options));
        return url.toString();
    }
    isOverwriteKey() {
        return this.overwriteKey
    }
    setOverwriteKey(true_or_false) {
        this.overwriteKey = true_or_false;
        return this;
    }

    // Optimistic concurrency ==================================================

    /**
     * The ETag of the most recent response, or null if it carried none (the key
     * does not exist, or the endpoint does not version).
     *
     * The server sends it on reads, on writes (the version just written, so a
     * read-modify-write loop can chain without re-reading) and on a 412, so a
     * client that loses a race learns the current version without a round trip.
     */
    getETag() {
        return this.lastEtag;
    }

    /**
     * Sends If-Match on the next request: the write proceeds only while the key
     * is still at this version, otherwise the server answers 412. Pass '*' to
     * mean "only if the key exists at all".
     *
     * One-shot - cleared once the request has been sent, like setBinary().
     */
    setIfMatch(etag) {
        this.ifMatch = etag === undefined ? null : etag;
        return this;
    }

    /**
     * Sends If-None-Match on the next request. The useful value is '*': a
     * conditional create that fails with 412 if the key already exists.
     *
     * If-Match wins if both are set, per RFC 9110 section 13.2.2.
     * One-shot, like setIfMatch().
     */
    setIfNoneMatch(etag) {
        this.ifNoneMatch = etag === undefined ? null : etag;
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
            Object.assign(params, _imageParams(this.imageOptions));
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

    /**
     * Lists key names matching a pattern, answered from the in-memory index
     * without reading any document.
     *
     * @param filters  RegExp or pattern string; omit for every readable key.
     * @param options  { limit, offset } to page, { count: true } for the total
     *                 alone with no key list.
     *
     * Resolves to { total, keys } - `total` is always the full number of
     * matches, so it can exceed `keys.length`. When the result is paged the
     * server adds `offset`, `limit` and `truncated`.
     *
     * Note that `truncated` can be true even when nothing was asked to be
     * paged: an operator can set `key_list_limit` in the server config, which
     * caps every listing. Check it rather than assuming `keys` is complete.
     */
    async listKeys(filters, options = {}) {
        return this._request({
            method: 'GET',
            uri: '/cmd/keys',
            query: this._listKeysQuery(filters, options)
        });
    }

    /** Shared by listKeys() and admin.keys(): /admin/keys forwards to the
     *  same server handler, so the options are identical. */
    _listKeysQuery(filters, options = {}) {
        const query = {};
        const pattern = _patternFrom(filters);
        if (pattern !== undefined) query.keys = pattern;
        // Bounds are passed through for the server to validate, so there is one
        // definition of what counts as valid; a bad one comes back as a 400.
        if (options.limit !== undefined) query.limit = options.limit;
        if (options.offset !== undefined) query.offset = options.offset;
        if (options.count) query.count = true;
        return query;
    }

    _createAdminAPI() {
        return {
            /**
             * GET /admin/keys - the same listing as listKeys(), including
             * `limit`/`offset`/`count` and the `key_list_limit` ceiling; the
             * server forwards both to one handler. Still filtered by read
             * permission, so for an admin it mirrors listKeys().
             */
            keys: (filters, options = {}) => this._request({
                method: 'GET',
                uri: '/admin/keys',
                query: this._listKeysQuery(filters, options)
            }),

            /**
             * GET /admin/health - process uptime, index size and disk usage.
             * Resolves to { uptime, storage: { indexedKeys, disk }, modifications }.
             * `storage.disk` is { error } instead of byte counts when the
             * filesystem could not be queried.
             */
            health: () => this._request({ method: 'GET', uri: '/admin/health' }),

            /**
             * GET /admin/modifications/:since - every key whose modCount is
             * above `since`, for polling changes without re-reading the keyspace.
             * Resolves to { latestModCount, changes: [{ key, modCount, modified,
             * operation }] }; feed `latestModCount` back in as the next `since`.
             */
            modifications: (since) => {
                // The server parseInt()s this and compares with >, so anything
                // unparseable yields an empty `changes` with a 200 - a silently
                // wrong answer rather than an error. Refuse it here instead.
                //
                // Only numbers and numeric strings are accepted. Number() is
                // too permissive on its own: null, '' and false all coerce to
                // 0, which would quietly mean "every change ever" rather than
                // failing on an accidental argument.
                const usable = (typeof since === 'number')
                    || (typeof since === 'string' && since.trim() !== '');
                const n = usable ? Number(since) : NaN;
                if (!Number.isInteger(n) || n < 0) {
                    throw new Error(
                        `admin.modifications(since) needs a non-negative integer, got ${JSON.stringify(since)}`
                    );
                }
                return this._request({ method: 'GET', uri: `/admin/modifications/${n}` });
            },

            /**
             * POST /admin/rebuild-index - reconstructs the index by reading
             * every data file on disk. Expensive; see rotateIndex() for the
             * cheap log compaction.
             */
            rebuildIndex: () => this._request({ method: 'POST', uri: '/admin/rebuild-index' }),

            /**
             * POST /admin/rotate-index - compacts the append-only index log,
             * rewriting it from the in-memory index. Does not read data files.
             */
            rotateIndex: () => this._request({ method: 'POST', uri: '/admin/rotate-index' }),

            /**
             * POST /admin/reload-access - re-reads access_file without a restart.
             *
             * A rejected file is a 400, not a 500: the server keeps serving on
             * the previous access data. The specific faults are in
             * `err.details.problems`, so surface those rather than just the message.
             */
            reloadAccess: () => this._request({ method: 'POST', uri: '/admin/reload-access' }),

            /**
             * GET /admin/logs - the last 7 days of log entries.
             *
             * Note the shape: an array *per day file*, newest day first, each
             * holding that day's entries - not one flat list. Days with no log
             * file are omitted entirely, so index does not map to age.
             */
            logs: () => this._request({ method: 'GET', uri: '/admin/logs' }),
        };
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

        // Conditional headers. Read before _resetFlags() clears them, and only
        // set when present so an unconditional request stays unconditional.
        if (this.ifMatch !== null && this.ifMatch !== undefined) {
            headers['If-Match'] = String(this.ifMatch);
        }
        if (this.ifNoneMatch !== null && this.ifNoneMatch !== undefined) {
            headers['If-None-Match'] = String(this.ifNoneMatch);
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
        this._captureETag(response);

        if (!response.ok) {
            const err = new Error(`API Error: ${response.status} ${response.statusText}`);
            err.status = response.status;
            err.details = await this._readBody(response, false);
            // On a 412 the server reports the version it actually holds, both in
            // the ETag header and as `current` in the body. Surfacing it on the
            // error lets a caller retry straight away.
            err.etag = this.lastEtag;
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

    /**
     * Remembers the ETag of this response. Always assigned, never left stale:
     * a response without one means the key has no version to match against,
     * and carrying the previous value forward would produce a wrong If-Match.
     */
    _captureETag(response) {
        const headers = response && response.headers;
        if (!headers) { this.lastEtag = null; return; }
        this.lastEtag = (typeof headers.get === 'function'
            ? headers.get('etag')
            : (headers['etag'] || headers['ETag'])) || null;
    }

    _resetFlags() {
        this.binary = false;
        this.overwriteKey = false;
        this.ifMatch = null;
        this.ifNoneMatch = null;
        this.imageOptions = null;
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
