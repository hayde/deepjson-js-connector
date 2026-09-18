# DeepJSON Server & Client

A high-performance JSON storage server with real-time synchronization capabilities and secure scripting support.

## Features

- JWT & HMAC Authentication
- CRUD Operations for JSON Data
- Binary File Handling (Images, Documents)
- Secure Script Execution (VM2 Sandbox)
- Real-time Synchronization Channels
- Role-based Access Control
- **Zero runtime dependencies** - runs on platform built-ins only

## Installation

### Node.js Client
```bash
npm install deepjson-connector
```

### Browser Client

One file, nothing else:

```html
<script src="path/to/deepjson-connector.js"></script>
```

No axios, no socket.io-client, no CDN. See [Offline use](#offline-use).

## Quick Start

### Basic Connection

#### Node.js

```javascript
const { Connector } = require('deepjson-client');

// Basic configuration
const dj = new Connector({
  baseURL: 'http://localhost:3000', // Server URL
  timeout: 15000, // Request timeout (ms)
  storage: 'local' // 'local' (persistent) or 'session' (tab-only)
});

// Advanced configuration
const djSecure = new Connector({
  baseURL: 'https://api.yourdomain.com',
  token: 'eyJhbGci...', // Preload existing JWT
  headers: {
    'X-Client-Version': '1.4.2'
  }
});
```

#### Browser

```javascript
// Initialize with default settings
const dj = new DeepJSONConnector({
  baseURL: 'http://localhost:3000'
});

// Initialize with existing token (e.g., from localStorage)
const djAuthenticated = new DeepJSONConnector({
  baseURL: 'http://localhost:3000',
  token: localStorage.getItem('dj_token')
});
```

### Authentification

```javascript
// Basic username/password login
try {
  const response = await dj.login('admin@example.com', 'securepassword123');
  console.log('Authenticated as:', response.user);
  console.log('JWT Token:', dj.getToken());
} catch (err) {
  console.error('Login failed:', err.message);
}

// Manual token handling (for existing sessions)
dj.setToken('eyJhbGciOiJIUzI1NiIsInR5c...');
```

#### Sliding session (token renewal)

Tokens are valid for one hour from the moment they are issued. A JWT carries its
expiry inside the signed payload, so an existing token cannot be extended — the
server instead issues a **new** token on every successful authenticated response
and returns it in the `X-Renewed-Token` header.

The connector picks that header up automatically for every request and replaces
its stored token, so an actively used session never expires. Nothing needs to be
done per call. To persist the renewed token outside of memory, pass the
`onTokenRenewed` callback:

```javascript
const dj = new Connector({
  baseURL: 'http://localhost:3000',
  token: localStorage.getItem('dj_token'),      // restore a previous session
  onTokenRenewed: (token) => {                  // keep it fresh
    localStorage.setItem('dj_token', token);
  }
});
```

Notes:

- The header is **not** sent on the login response (the first token comes from
  the `token` field of its body), not on `401` responses, and not for HMAC
  device authentication — those clients use no JWTs at all.
- In the browser the server must expose the header via
  `Access-Control-Expose-Headers: X-Renewed-Token` for cross-origin requests,
  otherwise the response header is invisible to JavaScript.
- A `socket.io` connection is only authenticated once, during the handshake.
  `SyncConnector` keeps the handshake token up to date with each renewal, but a
  connection open for more than an hour without any intervening HTTP request has
  to be re-established via `reconnect()`.

__Example Error Handling:__

```javascript
try {
  await dj.get('secured/data');
} catch (err) {
  if (err.status === 401) {
    console.log('Session expired - redirecting to login');
    window.location.href = '/login';
  } else {
    console.error('API Error:', err.details);
  }
}
```

### Basic Operations

#### Create/Update Data:

```javascript
// Create new entry
await dj.post('users/123', {
  name: 'Alice',
  roles: ['editor']
});

// Overwrite existing entry
const overwriteConfig = {
  overwriteKey: true
};
await dj.post('users/123', {
  name: 'Alicia' // Full replacement
}, overwriteConfig);

// Partial update
await dj.put('users/123', {
  roles: ['admin'] // Merge with existing data
});
```

#### Retrieve Data:

```javascript
// Simple GET
const userData = await dj.get('users/123');

// Get with query parameters
const filteredData = await dj.get('logs', {
  params: {
    dateFrom: '2024-01-01',
    limit: 50
  }
});
```

#### Delete Data:

```javascript
// Single entry
await dj.delete('users/123');

// Recursive delete (server must implement this)
await dj.delete('projects/old-project/*');
```


#### Move Data:

```javascript
// Move key location
await dj.move('users/temp/guest1', 'users/registered/guest1');

// Verify move
try {
  const oldData = await dj.get('users/temp/guest1');
} catch (err) {
  console.log('Old location cleared'); // Expected 404
}
const newData = await dj.get('users/registered/guest1');
```

### 2. Script Handling
```javascript
// Server-side script execution
const script = `javascript:
response = {
  modified: data.value.map(item => item * 2)
};
javascript!`;

const result = await dj.post('data.process', script);
```

### 3. Binary Files
```javascript
// Upload file (Browser)
const fileInput = document.querySelector('input[type="file"]');
await dj.uploadFile('documents/report.pdf', fileInput.files[0]);

// Download image with processing
const imgBlob = await dj.get('photos/sunset.jpg', {
  binary: true,
  width: 800,
  quality: 75
});
```

### 4. Real-time Sync
```javascript
const syncConnector = new Connector.Sync({
  baseURL: 'http://localhost:3000'
});

// Join collaboration session
await syncConnector.joinSession('design-session-12');

// Send real-time updates
syncConnector.send('canvas-update', {
  x: 120,
  y: 45,
  color: '#ff0000'
});

// Receive updates
syncConnector.on('canvas-update', (data) => {
  renderCanvas(data);
});
```

## Advanced Features



### Security Configuration
```javascript
// HMAC Device Auth
const deviceConnector = new Connector({
  baseURL: 'http://localhost:3000',
  hmacSecret: 'device-secret-123'
});

// Secure script execution
const safeScript = await dj.post('scripts/clean-data', {
  script: `// Safe operations only`,
  timeout: 5000,
  memoryLimit: 50
});
```

## Testing

```bash
npm test
```

The suite runs on `node:test`, built into Node - there is no test framework to
install, so it works on a machine with no internet access. It needs no
configuration, no running DeepJSON server, and **no credentials**: both stub
servers accept whatever is sent, and every token in the tests is an obvious
fake such as `test-token-1`.

| File | Covers |
|------|--------|
| `test/http.test.js` | auth, token renewal, CRUD, flags, scripts, errors, uploads |
| `test/socket.test.js` | the socket.io v4 protocol client and `SyncConnector` |
| `test/packaging.test.js` | zero-dependency guarantee, generated file freshness, no committed secrets |
| `test/helpers/` | the two stub servers, also dependency-free |

`test/helpers/socketio-server.js` is a miniature socket.io server built on
`node:http` and `node:crypto`: it does the RFC 6455 handshake and text framing,
then the engine.io / socket.io packet layer. That is what lets the realtime
tests run without installing `socket.io`.

### Node versions

The realtime tests need a global `WebSocket`, which Node has from v22. On
Node 18-21 `npm test` adds `--experimental-websocket` automatically; if the
flag is unavailable it says so and runs the HTTP tests only.

## Offline use

The connector has **no runtime dependencies**. It uses only what the platform
already provides - `fetch`, `FormData`, `Blob`, `URL` and `WebSocket` - so
nothing is downloaded at install time and nothing is fetched at runtime.

For a machine with no internet access, copy one file next to your HTML and
load it directly:

```html
<script src="deepjson-connector.js"></script>
<script>
  const dj = new DeepJSONConnector({ baseURL: 'http://localhost:3000' });
</script>
```

Either file works, both are self-contained:

| File | Size | Use |
|------|------|-----|
| `src/deepjson-connector.js` | ~26 KB | readable, easy to debug/patch on site |
| `dist/deepjson-connector.min.js` | ~11 KB | minified UMD |
| `dist/deepjson-connector.esm.js` | ~11 KB | `<script type="module">` / bundlers |

### Requirements

- **Browsers:** any current version. `fetch` and `WebSocket` are built in.
- **Node:** 18 or newer for HTTP (`fetch` became global in 18).
  Realtime additionally needs a `WebSocket`, which is global from Node 22.
  On Node 18-21 either start the process with `--experimental-websocket`, or
  hand one in:

  ```javascript
  import WebSocket from 'ws';
  const sync = new SyncConnector({ baseURL, WebSocket });
  ```

### Realtime without socket.io-client

The server speaks the socket.io v4 protocol, so a bare WebSocket is not enough
on its own. The connector ships a small client for that protocol
(`DeepJSONSocket`) covering what DeepJSON sessions use: the handshake query,
connect/disconnect, events, and automatic reconnect that re-reads the current
token.

It deliberately implements only the WebSocket transport - there is no
HTTP long-polling fallback. That is fine on a LAN and against any server
reachable by WebSocket. If you need polling (restrictive proxies), pass
socket.io-client in explicitly:

```javascript
import { io } from 'socket.io-client';
const sync = new SyncConnector({ baseURL, io });
```

## API Reference

| Method          | Description                         |
|-----------------|-------------------------------------|
| `.get(key)`     | Retrieve data/File                  |
| `.post(key, value)` | Create new entry               |
| `.put(key, value)`  | Update existing entry           |
| `.move(from, to)`   | Move data between keys         |
| `.sync()`           | Real-time operations            |
| `.listKeys(regEx)`  | list keys            |
| `.getToken()`       | current JWT (auto-renewed)      |
| `.setToken(token)`  | restore a persisted JWT         |
| `.uploadFile(key, file)` | upload a file              |


## Upgrading from 1.x

The public API is unchanged - `login`, `get`, `post`, `put`, `delete`, `move`,
`uploadFile`, `listKeys` and the flag setters all behave exactly as before.
Two things did change:

- **`connector.axios` is gone.** Nothing internally uses axios any more. If you
  reached into it (interceptors, custom adapters), use the `headers` and
  `onTokenRenewed` config options instead.
- **Node 18+ is required**, for the global `fetch`.

Installing the package no longer pulls axios, form-data or socket.io-client.

### Known dependents

A major version is opt-in: a project pinned to `^1.2.2` will never resolve to
2.x on its own, and npm gives no warning about it. Nothing here updates by
itself, so this list is the reminder.

| Where | How it consumes the connector | To update |
|-------|-------------------------------|-----------|
| `tr.nested.muhasebe.workflow.folder` | npm dependency, `require("deepjson-connector")` in `tasks/`, `api/`, `whatsapp/` | raise the range to `^2.0.0` and reinstall |
| `tr.nested.muhasebe.workflow.folder/public/lib/dj-local` | full git clone, served to the browser | `git pull` in that directory |
| `tr.nested.deepjson.client.javascript` | `deepjson-connector.js` copied next to the test pages | copy `src/deepjson-connector.js` over it |

Copied files carry no version, so npm can never update them - they have to be
refreshed by hand. If you add another copy somewhere, add a row here too.


## License

MIT License - See [LICENSE](LICENSE) for details
