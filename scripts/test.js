#!/usr/bin/env node
// Runs the test suite with node:test.
//
// The realtime tests need a global WebSocket. Node 22+ has one; 18-21 need
// --experimental-websocket. Rather than making everyone remember that, detect
// it here and add the flag only when this Node both lacks and supports it.
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const flags = [];

if (typeof WebSocket === 'undefined') {
    const probe = spawnSync(
        process.execPath,
        ['--experimental-websocket', '-e', 'process.exit(typeof WebSocket === "function" ? 0 : 1)'],
        { stdio: 'ignore' }
    );
    if (probe.status === 0) {
        flags.push('--experimental-websocket');
    } else {
        console.warn(
            '! No global WebSocket and --experimental-websocket is unavailable on ' +
            `${process.version}. The realtime tests will be skipped; HTTP tests still run.`
        );
    }
}

const explicit = process.argv.slice(2);
// Only *.test.js - pointing the runner at test/ would also collect
// test/helpers/*, which are fixtures, not tests.
const files = explicit.length
    ? explicit
    : fs.readdirSync(path.join(ROOT, 'test'))
        .filter(name => name.endsWith('.test.js'))
        .sort()
        .map(name => path.join('test', name));

const args = [...flags, '--test', ...files];

const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
