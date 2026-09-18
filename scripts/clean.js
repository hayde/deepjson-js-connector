#!/usr/bin/env node
// Wipes the build outputs. Kept as its own step because two webpack configs
// share lib/ and two share dist/ - webpack's own `clean: true` would have the
// second config delete what the first just wrote.
'use strict';
const fs = require('fs');
const path = require('path');
for (const dir of ['lib', 'dist']) {
    fs.rmSync(path.resolve(__dirname, '..', dir), { recursive: true, force: true });
}
console.log('clean: removed lib/ and dist/');
