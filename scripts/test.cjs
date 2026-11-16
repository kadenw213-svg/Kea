// `npm test`: every test file under test/ (passed one by one: a folder argument fails on Windows), with KEAS_DIR set to
// the old KeaS 0.5 Hub that the Hub, sync and Kea cloud tests run against (context/repos.md, "Setting up on a new PC").
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(__dirname, '..');
const files = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.test.mjs')) files.push(path.relative(root, p));
  }
})(path.join(root, 'test'));

const env = { ...process.env };
const fixture = path.join(os.tmpdir(), 'keac-keas-0.5-de75286');
if (!env.KEAS_DIR && fs.existsSync(path.join(fixture, 'hub', 'index.mjs'))) env.KEAS_DIR = fixture;
if (!env.KEAS_DIR)
  console.warn(`KEAS_DIR isn't set and ${fixture} isn't there, so the Hub, sync and Kea cloud tests will fail. Make it as in KeaContext/context/repos.md, step 4 of "Setting up on a new PC".`);

const r = spawnSync(process.execPath, ['--test', ...files], { cwd: root, env, stdio: 'inherit' });
process.exit(r.status ?? 1);
