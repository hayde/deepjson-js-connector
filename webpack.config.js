'use strict';
const path = require('path');

const SRC = './src/core.js';

/** Gemeinsame externals für Node-Builds (CJS/ESM) */
const nodeExternals = {
  'axios':            'axios',
  'form-data':        'form-data',
  'socket.io-client': 'socket.io-client',
};

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
    externals: nodeExternals,
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
    externals: nodeExternals,
    externalsType: 'module',
    optimization: { minimize: false, mangleExports: false },
  },

  // ── 3. UMD für klassischen <script>-Tag ──────────────────────────
  {
    name: 'browser-umd',
    entry: SRC,                       // ← gleiche Source!
    mode: 'production',
    target: ['web', 'es5'],
    resolve: {
        fallback: {fs: false},
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'deepjson-connector.min.js',
      library: { name: 'DeepJsonConnector', type: 'umd' },
      globalObject: 'this',
    },
    externals: {
      'socket.io-client': { root: 'io',       amd: 'socket.io-client', commonjs: 'socket.io-client', commonjs2: 'socket.io-client' },
      'axios':            { root: 'axios',    amd: 'axios',            commonjs: 'axios',            commonjs2: 'axios'            },
      'form-data':        { root: 'FormData', amd: 'form-data',        commonjs: 'form-data',        commonjs2: 'form-data'        },
    },
  },

  // ── 4. Browser-ESM standalone (alle Deps gebündelt, für unpkg) ───
  {
    name: 'browser-esm',
    entry: SRC,
    mode: 'production',
    target: 'web',
    experiments: { outputModule: true },
    resolve: {
        fallback: { fs: false },        // ← neu
    },
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'deepjson-connector.esm.js',
      library: { type: 'module' },
    },
    optimization: { minimize: true, mangleExports: false },
    // KEINE externals — alles bundlen, Browser hat kein npm
  },
];