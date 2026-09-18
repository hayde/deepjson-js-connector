'use strict';
const path = require('path');

const SRC = './src/core.js';

// Keine externals mehr: src/core.js hat keine Abhängigkeiten, alles läuft
// auf Plattform-Builtins (fetch, FormData, WebSocket).

/** @type {import('webpack').Configuration[]} */
module.exports = [

  // ── 1. CJS für Node ──────────────────────────────────────────────
  {
    name: 'cjs',
    entry: SRC,
    mode: 'production',
    target: 'node',
    output: {
      path: path.resolve(__dirname, 'lib'),
      filename: 'index.cjs',
      library: { type: 'commonjs2' },
    },
    optimization: { minimize: false, mangleExports: false },
  },

  // ── 2. ESM für Node + moderne Bundler + Browser-ESM-Imports ──────
  {
    name: 'esm',
    entry: SRC,                       // ← gleiche Source wie CJS!
    mode: 'production',
    target: 'node',
    experiments: { outputModule: true },
    output: {
      path: path.resolve(__dirname, 'lib'),
      filename: 'index.mjs',
      library: { type: 'module' },
    },
    optimization: { minimize: false, mangleExports: false },
  },

  // ── 3. UMD für klassischen <script>-Tag ──────────────────────────
  {
    name: 'browser-umd',
    entry: SRC,                       // ← gleiche Source!
    mode: 'production',
    target: ['web', 'es5'],
    resolve: {
        fallback: { fs: false, path: false },
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'deepjson-connector.min.js',
      library: { name: 'DeepJsonConnector', type: 'umd' },
      globalObject: 'this',
    },
  },

  // ── 4. Browser-ESM standalone (für unpkg) ───────────────────────
  {
    name: 'browser-esm',
    entry: SRC,
    mode: 'production',
    target: 'web',
    experiments: { outputModule: true },
    resolve: {
        fallback: { fs: false, path: false },
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'deepjson-connector.esm.js',
      library: { type: 'module' },
    },
    optimization: { minimize: true, mangleExports: false },
  },
];