// A scan's Claude can write files under data/ and may `cd data`. uv would then look there for its project, Python version
// and settings, and start whatever a planted pyproject.toml says. With a run's environment (runner.cjs's runEnv) uv uses
// the workspace's project wherever it's started. This runs the real uv on a small project (offline, no Claude).
// Run: node --test test/worker/uvplant.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('./electronStub.cjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-uvplant-test-'));
electron._paths.userData = dir;
electron._paths.appData = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const R = require('../../electron/scholar/runner.cjs')._test;
const profiles = require('../../electron/scholar/profiles.cjs');

const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['uv'], { encoding: 'utf8' });
const uv = found.status === 0 ? found.stdout.split(/\r?\n/)[0].trim() : '';
const PY = `import os, sys; print('RAN', os.path.realpath(sys.prefix))`;

test('what a run plants under data/ doesn’t change what uv runs', { skip: uv ? false : 'uv isn’t installed' }, () => {
  const ws = profiles.paths().workspace;
  const data = path.join(ws, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(ws, 'pyproject.toml'), '[project]\nname = "real"\nversion = "0.1.0"\nrequires-python = ">=3.10"\ndependencies = []\n');
  const env = R.runEnv(uv, 1, 'daily');
  // uv's own cache and Pythons, as this computer has them (a run gets these the same way).
  const run = (cwd, e, ...args) => spawnSync(uv, ['run', '--offline', ...args, 'python', '-c', PY], { cwd, env: e, encoding: 'utf8' });
  const synced = spawnSync(uv, ['sync', '--offline'], { cwd: ws, env, encoding: 'utf8' });
  assert.equal(synced.status, 0, synced.stderr);

  fs.writeFileSync(path.join(data, 'pyproject.toml'), '[project]\nname = "evil"\nversion = "0.1.0"\nrequires-python = ">=3.10"\ndependencies = []\n');
  fs.writeFileSync(path.join(data, '.python-version'), '3.1\n');
  fs.writeFileSync(path.join(data, 'uv.toml'), 'this is not valid toml = = =\n');
  fs.writeFileSync(path.join(data, '.env'), 'PYTHONPATH=evil\n');

  // (Without the run's settings, the planted files take over: uv fails on them here. That's the attack.)
  const bare = { ...env };
  for (const k of ['UV_PROJECT', 'UV_NO_CONFIG', 'UV_NO_ENV_FILE']) delete bare[k];
  const plain = run(data, bare);
  assert.notEqual(plain.status, 0, plain.stdout);

  // With them: the workspace's own environment, from the folder with the planted files.
  const r = run(data, env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^RAN /);
  assert.equal(path.resolve(r.stdout.trim().slice(4)).toLowerCase(), fs.realpathSync(path.join(ws, '.venv')).toLowerCase());
  assert.ok(!fs.existsSync(path.join(data, '.venv')), 'no environment was made from the planted project');
});
