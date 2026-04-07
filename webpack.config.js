// webpack.config.js
'use strict';

const path = require('path');

/** @type {import('webpack').Configuration[]} */
module.exports = [

  // ── 1. CommonJS (Node.js / legacy bundlers) ──────────────────────────────
  {
    name: 'cjs',
    entry: './src/deepjson-connector.js',
    mode: 'production',
    target: 'node',
    output: {
      path: path.resolve(__dirname, 'lib'),
      filename: 'index.cjs',
      library: { type: 'commonjs2' },
    },
    optimization: { minimize: false }, // readable source in lib/ for debugging
    externals: {
      // These are runtime deps listed in "dependencies" — consumers install them.
      // Externalising prevents double-bundling when the consumer also uses axios.
      'axios':            { commonjs: 'axios',            commonjs2: 'axios'            },
      'form-data':        { commonjs: 'form-data',        commonjs2: 'form-data'        },
      'socket.io-client': { commonjs: 'socket.io-client', commonjs2: 'socket.io-client' },
    },
  },

  // ── 2. ESM (Vite / Rollup / native Node ESM) ─────────────────────────────
  {
    name: 'esm',
    entry: './src/deepjson-connector.js',
    mode: 'production',
    target: 'node',          // still node semantics; bundlers override this
    experiments: {
      outputModule: true,    // webpack 5 native ESM output
    },
    output: {
      path: path.resolve(__dirname, 'lib'),
      filename: 'index.mjs',
      library: { type: 'module' },
    },
    optimization: { minimize: false, mangleExports: false, },
    externals: {
      'axios':            'axios',
      'form-data':        'form-data',
      'socket.io-client': 'socket.io-client',
    },
    externalsType: 'module', // tells webpack to emit: import axios from 'axios'
  },

  // ── 3. Browser UMD bundle (CDN / <script> tag) ───────────────────────────
  {
    name: 'browser',
    entry: './src/deepjson-connector.js',
    mode: 'production',
    target: ['web', 'es5'],
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'deepjson-connector.min.js',
      library: {
        name: 'DeepJsonConnector',
        type: 'umd',
      },
      globalObject: 'this',
    },
    externals: {
      // Consumers load these via CDN before the bundle
      'socket.io-client': { root: 'io',      amd: 'socket.io-client', commonjs: 'socket.io-client', commonjs2: 'socket.io-client' },
      'axios':            { root: 'axios',   amd: 'axios',            commonjs: 'axios',            commonjs2: 'axios'            },
      'form-data':        { root: 'FormData',amd: 'form-data',        commonjs: 'form-data',        commonjs2: 'form-data'        },
    },
  },

    // 4. In webpack.config.js, add this fourth entry to the exports array:
    {
        name: 'browser-esm',
        entry: './src/deepjson-connector.js',
        mode: 'production',
        target: 'web',
        experiments: { outputModule: true },
        output: {
            path: path.resolve(__dirname, 'dist'),
            filename: 'deepjson-connector.esm.js',  // ← this is the file the browser loads
            library: { type: 'module' },
        },
        optimization: { 
            minimize: true,
            mangleExports: false, },
    // NO externals — axios, socket.io-client bundled in
    },
];