// Guards the things that silently rot: the generated UMD file, the built
// bundles, and the promise that this package has no runtime dependencies.
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

describe('zero dependencies', () => {
    test('package.json declares no runtime dependencies', () => {
        const pkg = JSON.parse(read('package.json'));
        assert.equal(pkg.dependencies, undefined, 'there must be no "dependencies" field');
        assert.equal(pkg.optionalDependencies, undefined);
        assert.equal(pkg.peerDependencies, undefined);
    });

    test('the lockfile installs nothing for consumers', () => {
        if (!exists('package-lock.json')) return;
        const lock = JSON.parse(read('package-lock.json'));
        const runtime = Object.entries(lock.packages || {})
            .filter(([name, meta]) => name && !meta.dev);
        assert.deepEqual(runtime.map(([n]) => n), [],
            'no non-dev packages may appear in the lockfile');
    });

    test('the source imports nothing', () => {
        const core = read('src/core.js');
        assert.doesNotMatch(core, /^\s*import\s+[^(]/m, 'no static imports');
        assert.doesNotMatch(core, /\brequire\s*\(/, 'no require() calls');
        // The only dynamic imports are Node built-ins, used behind isNode.
        const dynamic = [...core.matchAll(/import\([^)]*?'([^']+)'\)/g)].map(m => m[1]);
        assert.deepEqual(dynamic.sort(), ['fs', 'path'], 'only fs and path, lazily');
    });

    test('no CDN or remote URLs are referenced by the shipped code', () => {
        for (const file of ['src/core.js', 'src/deepjson-connector.js']) {
            assert.doesNotMatch(read(file), /https?:\/\/(cdn|unpkg|cdnjs)/,
                `${file} must not reference a CDN`);
        }
    });
});

describe('generated UMD file', () => {
    test('src/deepjson-connector.js is up to date with src/core.js', () => {
        const { generate } = require('../scripts/build-umd.js');
        const expected = generate(read('src/core.js'));
        assert.equal(read('src/deepjson-connector.js'), expected,
            'src/deepjson-connector.js is generated - edit src/core.js and run `npm run build:umd`');
    });

    test('it is loadable as CommonJS and exposes the public names', () => {
        const mod = require('../src/deepjson-connector.js');
        for (const name of ['Connector', 'SyncConnector', 'DeepJSONConnector',
                            'DeepJSONSyncConnector', 'DeepJSONSocket']) {
            assert.equal(typeof mod[name], 'function', `${name} is exported`);
        }
    });
});

describe('build outputs', { skip: exists('lib/index.cjs') ? false : 'not built yet - run npm run build' }, () => {
    test('lib/index.cjs exposes the public API', () => {
        const mod = require('../lib/index.cjs');
        assert.equal(typeof mod.Connector, 'function');
        assert.equal(typeof mod.SyncConnector, 'function');
    });

    test('the browser bundle carries no chunk loader', () => {
        // A dynamic import that webpack decides to split produces a second
        // file plus a loader that fetches it - fatal for offline <script> use.
        const bundle = read('dist/deepjson-connector.min.js');
        assert.doesNotMatch(bundle, /Automatic publicPath/,
            'bundle must not contain webpack\'s chunk-loading runtime');
        const stray = fs.readdirSync(path.join(ROOT, 'dist'))
            .filter(f => /^\d+\./.test(f));
        assert.deepEqual(stray, [], 'no split chunks may be emitted');
    });

    test('dist ships exactly the two browser builds', () => {
        const files = fs.readdirSync(path.join(ROOT, 'dist')).filter(f => f.endsWith('.js')).sort();
        assert.deepEqual(files, ['deepjson-connector.esm.js', 'deepjson-connector.min.js']);
    });
});

describe('no credentials in the repository', () => {
    // The tests authenticate against a stub that accepts anything, so nothing
    // resembling a real secret should ever be committed here.
    const files = ['src/core.js', 'src/deepjson-connector.js', 'README.md',
                   'test/http.test.js', 'test/socket.test.js',
                   'test/helpers/http-server.js', 'test/helpers/socketio-server.js'];

    test('no hard-coded passwords or bearer tokens', () => {
        const suspicious = [
            /password\s*[:=]\s*['"](?!any-password|secret-not-real|\$|<)[^'"]{3,}['"]/i,
            // A real JWT: three substantial segments. Truncated doc
            // placeholders like 'eyJhbGciOiJIUzI1NiIsInR5c...' never match.
            /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
            /Bearer\s+(?!\$\{|<|test-|restored-|directly-|renewed-)[A-Za-z0-9._-]{16,}/,
        ];
        for (const file of files.filter(exists)) {
            const content = read(file);
            for (const pattern of suspicious) {
                assert.doesNotMatch(content, pattern, `${file} looks like it contains a credential`);
            }
        }
    });
});
