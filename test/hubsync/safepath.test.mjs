// A Hub's listing decides which files Kea writes into its sync folder: no name it sends may ever leave that folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { safeLocal, inside, createSync } = require('../../electron/scholar/hubsync.cjs');

const BAD = [
  'kea/../../evil.txt',
  'kea/~2e~~2e~/~2e~~2e~/evil.txt',
  'kea/Documents/../../../../Startup/run.bat',
  'kea/a/~5c~..~5c~x',
  'kea/~5c~~5c~srv~5c~share',
  'kea/a~2f~..',
  'kea/C:/x',
  'kea/~43~~3a~~5c~x',
  'kea/NUL',
  'kea/con.txt',
  'kea/COM1.log',
  'kea/a/b.txt:ads',
  'kea/x. ',
  'kea/a~0~b',
  'kea/..',
  'kea/./x',
  'kea//x',
  'notkea/x',
];
const GOOD = ['kea/Documents/Essay.docx', 'kea/Profiles/School/kea.json', 'kea/Shared/BIO 111/ch 1.pdf', 'kea/Notes (1).txt'];

test('Hub paths that could leave the sync folder are refused', () => {
  for (const p of BAD) assert.equal(safeLocal(p), null, p);
  for (const p of GOOD) assert.ok(safeLocal(p), p);
  const root = path.join(os.tmpdir(), 'kea-root');
  assert.equal(inside(root, '../x'), null);
  assert.equal(inside(root, ''), null);
  assert.ok(inside(root, 'Documents/a.txt'));
});

test('a malicious listing writes nothing outside the folder, and a near-empty listing deletes nothing here', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-safe-'));
  const root = path.join(dir, 'sync');
  let files = [
    { path: 'kea/../escaped.txt', version: 'v1', size: 4 },
    { path: 'kea/~2e~~2e~/escaped2.txt', version: 'v1', size: 4 },
    ...Array.from({ length: 30 }, (_, i) => ({ path: `kea/Documents/f${i}.txt`, version: 'v1', size: 4 })),
  ];
  const client = {
    list: async () => ({ files, now: Date.now() }),
    get: async () => Buffer.from('evil'),
    put: async () => ({ version: 'v2' }),
    del: async () => ({}),
  };
  let t = Date.now();
  const sync = createSync({ root, stateFile: path.join(dir, 'state.json'), client, now: () => t });
  await sync.cycle();
  assert.ok(!fs.existsSync(path.join(dir, 'escaped.txt')));
  assert.ok(!fs.existsSync(path.join(dir, 'escaped2.txt')));
  assert.equal(fs.readdirSync(path.join(root, 'Documents')).length, 30);
  // The Hub now lists none of them: that's not a real deletion, so the files stay.
  files = [];
  t += 10 * 60_000;
  await sync.cycle();
  assert.equal(fs.readdirSync(path.join(root, 'Documents')).length, 30);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a name with a code point past U+10FFFF is skipped, never thrown on (one bad name never stops all sync)', async () => {
  const { decodeSeg, toLocal } = require('../../electron/scholar/hubsync.cjs');
  for (const s of ['~110000~', 'a~ffffffff~b', '~1234567~', `~${'f'.repeat(40)}~`]) {
    assert.doesNotThrow(() => decodeSeg(s), s);
    assert.equal(decodeSeg(s), null, s);
    assert.equal(safeLocal(`kea/Documents/${s}.txt`), null, s);
  }
  assert.equal(toLocal('kea/a/~110000~'), null);
  assert.equal(decodeSeg('~10ffff~'), String.fromCodePoint(0x10ffff));
  assert.equal(toLocal('kea/a/b~20~c'), 'a/b c');
  // A listing with such a name next to good ones: the good ones still arrive.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-cp-'));
  const root = path.join(dir, 'sync');
  const files = [{ path: 'kea/Documents/~110000~.txt', version: 'v1', size: 2 }, { path: 'kea/Documents/ok.txt', version: 'v1', size: 2 }];
  const client = { list: async () => ({ files, now: Date.now() }), get: async () => Buffer.from('ok'), put: async () => ({ version: 'v2' }), del: async () => ({}) };
  const sync = createSync({ root, stateFile: path.join(dir, 'state.json'), client });
  await sync.cycle();
  assert.deepEqual(fs.readdirSync(path.join(root, 'Documents')), ['ok.txt']);
  fs.rmSync(dir, { recursive: true, force: true });
});
