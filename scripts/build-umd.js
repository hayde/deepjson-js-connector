#!/usr/bin/env node
// Generates src/deepjson-connector.js (readable UMD, loadable straight from a
// <script> tag) out of src/core.js. Both files used to be maintained by hand
// and drifted apart; now core.js is the single source of truth.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'core.js');
const OUT = path.join(ROOT, 'src', 'deepjson-connector.js');

/** Turns the ESM source into the UMD file. Pure, so tests can diff it. */
function generate(source) {
// core.js has no imports at all - it only needs its export syntax removed.
if (/^\s*import\s/m.test(source)) {
    throw new Error('src/core.js has a static import; the UMD build expects zero dependencies.');
}

let body = source
    .replace(/^\/\/ src\/core\.js\n/, '')
    .replace(/^export\s+(class|const|function)\s/gm, '$1 ')
    .replace(/\n*export default \{[\s\S]*?\};\s*$/m, '\n');

const indented = body.split('\n')
    .map(line => (line.trim() ? '    ' + line : line))
    .join('\n');

const out = `// deepjson-connector.js
//
// GENERATED FILE - do not edit. Produced from src/core.js by
// scripts/build-umd.js (npm run build). Edit src/core.js instead.
//
// Zero dependencies: no axios, no form-data, no socket.io-client. Drop this
// single file next to an HTML page and load it with a plain <script> tag -
// it needs no network access and no build step.

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        define([], factory);
    } else if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        const ex = factory();
        root.Connector = ex.Connector;
        root.SyncConnector = ex.SyncConnector;
        root.DeepJSONConnector = ex.Connector;
        root.DeepJSONSyncConnector = ex.SyncConnector;
        root.DeepJSONSocket = ex.DeepJSONSocket;
    }
}(typeof self !== 'undefined' ? self : this, function () {
${indented}
    return {
        Connector: DeepJSONConnector,
        SyncConnector: DeepJSONSyncConnector,
        DeepJSONConnector: DeepJSONConnector,
        DeepJSONSyncConnector: DeepJSONSyncConnector,
        DeepJSONSocket: DeepJSONSocket
    };
}));
`;

return out;
}

module.exports = { generate, SRC, OUT };

if (require.main === module) {
    const out = generate(fs.readFileSync(SRC, 'utf8'));
    fs.writeFileSync(OUT, out);
    console.log(`build-umd: wrote ${path.relative(ROOT, OUT)} (${out.split('\n').length} lines) from src/core.js`);
}
