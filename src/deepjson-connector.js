// deepjson-connector.js

// Universal Module Setup (updated with socket.io-client)
(function(root, factory) {
    if (typeof define === 'function' && define.amd) {
        // AMD
        define(['axios', 'socket.io-client'], function(axios, io) {
            return factory(axios, root.FormData, io);
        });
    } else if (typeof module === 'object' && module.exports) {
        // CommonJS (Node)
        const axios = require('axios');
        const FormData = require('form-data');
        const io = require('socket.io-client');
        const fs = require('fs');
        module.exports = factory(axios, FormData, io, fs);
    } else {
        // Browser global
        root.DeepJSONConnector = factory(root.axios, root.FormData, root.io);
    }
}(typeof self !== 'undefined' ? self : this, function(axios, FormData, io, fs) {

class DeepJSONConnector {
    constructor(config) {
        this.baseURL = config.baseURL;
        this.token = config.token || null;
        this.storage = config.storage || 'memory';
        
        // transmition options
        this.binary = false;
        this.overwriteKey = false;
        this.getBody = false;
        
        // Platform detection
        this.isNode = typeof process !== 'undefined' && process.versions?.node;
        
        // Configure axios instance
        this.axios = axios.create({
            baseURL: this.baseURL,
            timeout: config.timeout || 10000,
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'DeepJSONConnector/1.0'
            }
        });
    }

    // Authentication methods
    async login(username, password) {
        try {
            const response = await this.axios.post('/auth/login', { username, password });
            this.token = response.data.token;
            return response.data;
        } catch (error) {
            this._handleError(error);
        }
    }

    getToken() {
        return this.token;
    }

    isBinary() {
        return this.binary;
    }
    setBinary( true_or_false ) {
        this.binary = true_or_false
        return this;
    }
    isOverwriteKey() {
        return this.overwriteKey
    }
    setOverwriteKey( true_or_false ) {
        this.overwriteKey = true_or_false;
        return this;
    }
    hasGetBody() {
        return this.getBody;
    }
    setGetBody( true_or_false ) {
        this.getBody = true_or_false;
        return this;
    }

    // Core CRUD operations
    async get(key, value = '') {
        const headers = {};
        const params = {}
        let httpMethod = "GET";
        if (this.getBody) {
            // here we 
            headers['X-Method-Override'] = "GET";
            httpMethod = "POST";
        }
        if( this.binary ) {
            params.binary = true;
            params.token = this.token;
        }
        return this._request(httpMethod, `/keys/${key}`, params, value, { headers });
    }

    async post(key, value ) {
        const headers = {};
        if (this.overwriteKey) headers['X-Override-Existing'] = 'true';

        return this._request('POST', `/keys/${key}`, null, value, { headers });
    }

    async put(key, value) {
        const headers = {};
        return this._request('PUT', `/keys/${key}`, null,  value, { headers });
    }

    async delete(key) {
        const headers = {};
        return this._request('DELETE', `/keys/${key}`, null, null, { headers });
    }    

    async move(key, key_to ) {
        const headers = {};
        headers['Content-Type'] = "application/json; charset=utf-8";
        var value = { from: key, to: key_to };
        return this._request('POST', `/cmd/move`, null, JSON.stringify(value), { headers });
    }

    // Universal file upload
    async uploadFile(key, file, options = {}) {
        let form;
        if (this.isNode) {
            // Node.js FormData with streams
            const stream = fs.createReadStream(file);
            const stats = fs.statSync(file);

            form = new FormData();
            form.append('file', stream, {
                filename: file.name,
                size: stats.size
            });
        } else {
            // Browser FormData
            form = new FormData();
            form.append('file', file, file.name);
        }

        const headers = {
            ...(this.isNode ? form.getHeaders() : {}),
            'X-Override-Existing': options.overwrite ? 'true' : 'false'
        };

        return this._request('POST', `/keys/${key}`, null, form, { headers });
    }

    // key list methods
    async listKeys( filters ) {
        return this._request('GET', '/cmd/keys', filters, null, {} );
    }

    // Private methods
    async _request(method, path, params = null,  data = null, config = {}) {
        try {
            const requestConfig = {
                method,
                url: path,
                headers: {
                    ...config.headers,
                    ...(this.token && { 'Authorization': `Bearer ${this.token}` })
                },
                params: params || {},
                data
            };

            // Handle FormData in browser
            if (!this.isNode && data instanceof FormData) {
                requestConfig.data = data;
                delete requestConfig.headers['Content-Type']; // Let browser set boundary
            } else if( !requestConfig.headers["Content-Type"] ) {
                // Only set Content-Type for non-FormData requests, and if not set already
                requestConfig.headers["Content-Type"] = "text/plain; charset=utf-8";
            }
            this._resetFlags();

            var url = this.axios.getUri(requestConfig);
            console.log( url );
            const response = await this.axios(requestConfig);
            return response.data;
        } catch (error) {
            this._handleError(error);
        }
    }

    _resetFlags() {
        this.binary = false;
        this.overwriteKey = false;
        this.getBody = false;
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

class DeepJSONSyncConnector extends DeepJSONConnector {
    constructor(config) {
        super(config);
        this.socket = null;
        this.sessionHandlers = new Map();
        this.currentChannel = null;
    }

    // Session Management ======================================================
    async createSession() {
        if (this.socket) this.disconnect();
        
        this.socket = io(this.baseURL, {
            query: {
                token: this.token,
                action: 'create'
            }
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

        this.socket = io(this.baseURL, {
            query: {
                token: this.token,
                action: 'connect',
                channelId: channelId
            }
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
                //FIXED: Use proper event emission
                // this.emit(event, ...args);
                this.sessionHandlers.get(event)?.forEach(handler => handler(...args));
            });
        });

        // Forward custom messages
        //this.socket.on('message', (payload) => {
        //    this.emit(payload.type, payload.data);
        //});
        // Forward custom messages
        this.socket.on('message', (payload) => {
            const handlers = this.sessionHandlers.get(payload.type) || [];
            handlers.forEach(handler => handler(payload.data));
        });
    }

    // Override login to handle socket reauthentication
    async login(username, password) {
        const result = await super.login(username, password);
        if (this.socket) {
            this.socket.io.opts.query.token = this.token;
            this.reconnect();
        }
        return result;
    }
}

// Export as main object with aliases
const Exports = {
    Connector: DeepJSONConnector,          // Main export
    Sync: DeepJSONSyncConnector,           // Alias for sync version
    DeepJSONConnector: DeepJSONConnector,  // Preserve original name
    DeepJSONSyncConnector: DeepJSONSyncConnector
};

return Exports;
}));