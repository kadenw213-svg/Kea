// The shared-Claude compatibility cells (Teach lessons through the Kea account, the locked models, usage reports):
//   current Kea x current KeaC          a lesson end to end (asked, written by the owner's Kea on Sonnet, streamed),
//                                       its tokens counted, the lesson limit's refusal, a scan job's locked model and usage
//   current Kea x KeaC 0.4.0           no sharedTeach: Kea doesn't offer it; the lesson writer waits; usage is ignored
//   Kea 0.85.0 x current KeaC          an older Kea never asks; with no Kea writing lessons, a clear 503 no_worker; its
//                                       worker's finish (no usage) counts as one untracked job
// Each cell runs a real KeaC on 127.0.0.1 port 0 with scratch data, in a child process (shared-claude-cell.mjs). The
// previous releases are read with git show (harness.mjs extract), pinned here.
// The same file is in Kea and KeaC (test/compat/shared-claude.test.mjs): keep them the same.
//   node --test test/compat/shared-claude.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DIRS, extract } from './harness.mjs';

// The releases before shared Teach and usage tracking (commits in each repo).
const PREVIOUS = { keac: { label: '0.4.0', commit: 'e8c7cb7' }, kea: { label: '0.85.0', commit: '9335cfc' } };
const current = (repo) => (existsSync(join(DIRS[repo], repo === 'kea' ? 'electron/hub.cjs' : 'server/index.mjs')) ? { label: 'current', dir: DIRS[repo] } : { error: `no ${repo} at ${DIRS[repo]}` });
const previous = (repo) => {
  const x = extract(repo, PREVIOUS[repo].commit);
  return x.error ? { error: x.error } : { label: PREVIOUS[repo].label, dir: x.dir };
};
const fake = join(DIRS.kea, 'test', 'sharedclaude', 'fake-claude.cjs');
const CELLS = [
  ['current Kea x current KeaC', current('kea'), current('keac')],
  ['current Kea x KeaC 0.4.0', current('kea'), previous('keac')],
  ['Kea 0.85.0 x current KeaC', previous('kea'), current('keac')],
];

function runCell(spec) {
  return new Promise((done) => {
    const dir = mkdtempSync(join(tmpdir(), 'kea-compat-sc-run-'));
    const specFile = join(dir, 'spec.json'), outFile = join(dir, 'out.json');
    writeFileSync(specFile, JSON.stringify(spec));
    let log = '';
    const child = spawn(process.execPath, [join(import.meta.dirname, 'shared-claude-cell.mjs'), specFile, outFile], {
      cwd: dir, env: { ...process.env, KEAC_RELEASE_FEEDS: '0', KEAS_RELEASE_FEEDS: '0', NODE_OPTIONS: '', NODE_PATH: join(DIRS.kea, 'node_modules') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    child.stdout.on('data', (d) => (log = (log + d).slice(-8000)));
    child.stderr.on('data', (d) => (log = (log + d).slice(-8000)));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on('exit', () => {
      clearTimeout(timer);
      let res;
      try {
        res = JSON.parse(readFileSync(outFile, 'utf8'));
      } catch {
        res = { steps: [], fatal: `the cell ended without a result:\n${log}` };
      }
      rmSync(dir, { recursive: true, force: true });
      done({ ...res, log });
    });
  });
}

for (const [name, kea, keac] of CELLS) {
  const skip = kea.error || keac.error || (!existsSync(fake) ? `no ${fake}` : false);
  test(`shared Claude: ${name}`, { skip, timeout: 180_000 }, async (t) => {
    const res = await runCell({ kea, keac, keaDir: DIRS.kea });
    assert.equal(res.fatal, null, res.fatal);
    assert.ok(res.steps.length, `no steps ran\n${res.log}`);
    for (const s of res.steps) if (s.ok && s.detail !== undefined) t.diagnostic(`${s.name}: ${JSON.stringify(s.detail)}`);
    const failed = res.steps.filter((s) => !s.ok);
    assert.deepEqual(failed.map((s) => s.name), [], failed.map((s) => `${s.name}: ${s.error}${s.data ? `\n  data: ${JSON.stringify(s.data)}` : ''}`).join('\n\n'));
  });
}
