// What Claude remembers about a context folder (src/lib/projectMemory.ts): the notes file round-trips, Claude's
// remember/forget tools keep it tidy, private things are refused, and Claude is given the notes once per change.
// Bundled for Node the way the app bundles it, with Kea's file API kept in memory.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const disk = new Map();
let M;
before(async () => {
  globalThis.window = {
    api: {
      settings: { set() {}, get: async () => ({}), onChange() {} },
      readFile: async (p) => {
        if (!disk.has(p)) throw new Error('ENOENT');
        return { path: p, name: path.basename(p), data: disk.get(p) };
      },
      writeFile: async (p, data) => void disk.set(p, data)
    }
  };
  globalThis.document = { documentElement: { style: { setProperty() {} }, dataset: {}, classList: { toggle() {} } } };
  const out = path.join(os.tmpdir(), `kea-project-memory-${process.pid}.cjs`);
  await require('esbuild').build({ entryPoints: [path.resolve(here, '../../src/lib/projectMemory.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  M = require(out);
  fs.rmSync(out, { force: true });
});

const P = { dir: 'C:\\Kea cloud\\Context folders\\YMCA', name: 'YMCA front desk', kind: 'work', exclude: [] };
const tool = (name) => M.memoryTools(P).find((t) => t.name === name);
const text = () => new TextDecoder().decode(disk.get(M.memoryPath(P.dir)));

test('the notes file sits in the folder as .kea-memory.md and round-trips by topic', () => {
  assert.equal(M.memoryPath(P.dir), 'C:\\Kea cloud\\Context folders\\YMCA\\.kea-memory.md');
  const notes = [
    { topic: 'People', text: 'Ana Ruiz runs Saturday shifts.' },
    { topic: 'Preferences', text: 'Sign reminders as Kaden, front desk lead.' }
  ];
  const md = M.writeMemoryText('YMCA front desk', notes);
  assert.match(md, /## Preferences\n- Sign reminders/);
  assert.ok(md.indexOf('## Preferences') < md.indexOf('## People'), 'topics in a fixed order');
  assert.deepEqual(M.parseMemory(md).map((n) => n.text).sort(), notes.map((n) => n.text).sort());
});

test('remember saves, skips duplicates, and updates a note it replaces', async () => {
  disk.clear();
  assert.match(await tool('remember').run({ note: 'Shifts are 6-2 and 2-10.', topic: 'facts' }), /Saved/);
  assert.equal(await tool('remember').run({ note: 'shifts are 6-2 and 2-10', topic: 'facts' }), 'Already in the notes.');
  assert.match(await tool('remember').run({ note: 'Shifts are 6-2, 2-10 and 10-6.', topic: 'facts', replaces: '6-2 and 2-10' }), /Updated/);
  const notes = M.parseMemory(text());
  assert.equal(notes.length, 1);
  assert.equal(notes[0].text, 'Shifts are 6-2, 2-10 and 10-6.');
  assert.equal(notes[0].topic, 'Facts');
});

test('remember refuses passwords and account numbers', async () => {
  await assert.rejects(() => tool('remember').run({ note: 'The front desk password is hunter2', topic: 'facts' }), /private/);
});

test('forget removes one matching note and asks when several match', async () => {
  disk.clear();
  await tool('remember').run({ note: 'Ana Ruiz runs Saturdays.', topic: 'people' });
  await tool('remember').run({ note: 'Ana Ruiz prefers texts.', topic: 'people' });
  await assert.rejects(() => tool('forget').run({ note: 'Ana Ruiz' }), /matches 2 notes/);
  assert.match(await tool('forget').run({ note: 'prefers texts' }), /Forgot/);
  assert.equal(M.parseMemory(text()).length, 1);
});

test('Claude gets the notes with a signature that changes when they do', async () => {
  disk.clear();
  assert.equal((await M.memoryForClaude(P)).text, '');
  await tool('remember').run({ note: 'Keep reminder emails under 80 words.', topic: 'preferences' });
  const a = await M.memoryForClaude(P);
  assert.match(a.text, /YMCA front desk/);
  assert.match(a.text, /Keep reminder emails under 80 words/);
  await tool('remember').run({ note: 'Ben Cole is the weekend supervisor.', topic: 'people' });
  const b = await M.memoryForClaude(P);
  assert.notEqual(a.sig, b.sig);
});

test('a folder shared view-only gives Claude no tools to change the notes', () => {
  assert.equal(M.memoryTools({ ...P, shared: { access: 'view' } }).length, 0);
});
