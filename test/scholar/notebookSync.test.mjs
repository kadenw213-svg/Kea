// Study notebooks between devices (electron/scholar/notebookSync.cjs): the primary's copy in the Devices folder, the
// other computers' changes in their cards. A change on one side travels; a change on both keeps both
// ("<name> (from <device>).md"); deletions don't travel; nothing with a bad name, outside the folder or over 5 MB is
// taken in; the phone copy stays within its budget. Also notebooks.cjs's save that never writes over a change that
// arrived meanwhile, and that the files' names survive the Kea cloud sync's path rules.
//   node --test test/scholar/notebookSync.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../../electron/scholar/notebookSync.cjs');
const N = require('../../electron/scholar/notebooks.cjs');
const hubsync = require('../../electron/scholar/hubsync.cjs');

const made = [];
after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

/** A primary ("Desk"), its shared folder, and two other computers ("Laptop", "Tablet"), each with its own base. */
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-nbsync-'));
  made.push(root);
  const dir = (n) => path.join(root, n, 'study', 'Notebooks');
  const w = {
    root,
    desk: dir('desk'),
    shared: path.join(root, 'drive', 'Devices', 'shared', 'study', 'Notebooks'),
    laptop: { dir: dir('laptop'), base: {}, seen: {} },
    tablet: { dir: dir('tablet'), base: {}, seen: {} },
    // One round for a computer, the way devices.cjs runs it: its card goes out, the primary takes it in and shares,
    // then the computer brings the primary's in.
    send(pc, name) {
      const out = S.outgoing(pc.dir, pc.base);
      const r = S.takeIn(w.desk, out, name, pc.seen);
      S.publish(w.desk, w.shared);
      return r;
    },
    pull(pc) {
      S.publish(w.desk, w.shared);
      return S.pull(pc.dir, w.shared, pc.base, 'Desk');
    },
    round(pc, name) {
      w.send(pc, name);
      return w.pull(pc);
    }
  };
  return w;
}
const files = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);
const all = (d) => Object.fromEntries(N.list(d).map((e) => [e.name, N.read(d, e.name)]));

test('a notebook made on one computer reaches the primary and the other computers, unchanged', () => {
  const w = world();
  const text = '# Cells\n\n- ask: why two membranes?\n\u00e9 \u2713\r\nend';
  N.write(w.laptop.dir, 'Bio ch 4', text);
  w.round(w.laptop, 'Laptop');
  assert.equal(N.read(w.desk, 'Bio ch 4'), text);
  assert.equal(fs.readFileSync(path.join(w.shared, 'Bio ch 4.md'), 'utf8'), text);
  w.pull(w.tablet);
  assert.equal(N.read(w.tablet.dir, 'Bio ch 4'), text);
  // Now agreed everywhere: nothing more goes out.
  assert.deepEqual(S.outgoing(w.laptop.dir, w.laptop.base), {});
  assert.deepEqual(S.outgoing(w.tablet.dir, w.tablet.base), {});
});

test('a change on one side only travels both ways, and repeating a round changes nothing', () => {
  const w = world();
  N.write(w.desk, 'Notes', 'v1');
  w.pull(w.laptop);
  assert.equal(N.read(w.laptop.dir, 'Notes'), 'v1');
  // Changed on the primary only.
  N.write(w.desk, 'Notes', 'v2 from desk');
  w.round(w.laptop, 'Laptop');
  assert.equal(N.read(w.laptop.dir, 'Notes'), 'v2 from desk');
  // Changed on the laptop only.
  N.write(w.laptop.dir, 'Notes', 'v3 from laptop');
  w.round(w.laptop, 'Laptop');
  assert.equal(N.read(w.desk, 'Notes'), 'v3 from laptop');
  const before = { desk: files(w.desk), laptop: files(w.laptop.dir) };
  const again = w.round(w.laptop, 'Laptop');
  assert.equal(again.changed, false);
  assert.deepEqual({ desk: files(w.desk), laptop: files(w.laptop.dir) }, before);
  assert.deepEqual(files(w.desk), ['Notes.md'], 'no copies when nothing clashed');
});

test('changed on both sides, the computer finds it first: both texts are kept, on both, once', () => {
  const w = world();
  N.write(w.desk, 'Exam 2', 'start');
  w.pull(w.laptop);
  N.write(w.desk, 'Exam 2', 'desk text');
  N.write(w.laptop.dir, 'Exam 2', 'laptop text');
  const r = w.pull(w.laptop);
  assert.deepEqual(r.copies, [{ name: 'Exam 2', copy: 'Exam 2 (from Desk)' }]);
  assert.equal(N.read(w.laptop.dir, 'Exam 2'), 'laptop text', 'this computer’s text stays');
  assert.equal(N.read(w.laptop.dir, 'Exam 2 (from Desk)'), 'desk text');
  // Its text and the copy go to the primary; the laptop's text is now on top there too (it started from the desk's).
  w.round(w.laptop, 'Laptop');
  w.round(w.laptop, 'Laptop');
  assert.deepEqual(all(w.desk), { 'Exam 2': 'laptop text', 'Exam 2 (from Desk)': 'desk text' });
  assert.deepEqual(all(w.laptop.dir), all(w.desk));
});

test('changed on both sides, the primary finds it first: both kept, and the computer doesn’t make a second copy', () => {
  const w = world();
  N.write(w.desk, 'Lab', 'start');
  w.pull(w.laptop);
  N.write(w.desk, 'Lab', 'desk text');
  N.write(w.laptop.dir, 'Lab', 'laptop text');
  const r = w.send(w.laptop, 'Laptop');
  assert.deepEqual(r.copies, [{ name: 'Lab', copy: 'Lab (from Laptop)' }]);
  assert.equal(N.read(w.desk, 'Lab'), 'desk text', 'the primary’s text stays');
  w.pull(w.laptop);
  w.round(w.laptop, 'Laptop');
  assert.deepEqual(all(w.desk), { Lab: 'desk text', 'Lab (from Laptop)': 'laptop text' });
  assert.deepEqual(all(w.laptop.dir), all(w.desk));
});

test('the same card read again later (its heartbeat) doesn’t copy old text over a newer change on the primary', () => {
  const w = world();
  N.write(w.desk, 'Ch 1', 'start');
  w.pull(w.laptop);
  N.write(w.laptop.dir, 'Ch 1', 'laptop edit');
  const card = S.outgoing(w.laptop.dir, w.laptop.base);
  S.takeIn(w.desk, card, 'Laptop', w.laptop.seen);
  assert.equal(N.read(w.desk, 'Ch 1'), 'laptop edit');
  N.write(w.desk, 'Ch 1', 'desk edit after');
  const r = S.takeIn(w.desk, card, 'Laptop', w.laptop.seen);
  assert.equal(r.changed, false);
  assert.deepEqual(all(w.desk), { 'Ch 1': 'desk edit after' });
});

test('deletions don’t travel, and nothing deleted comes back unless it changed elsewhere', () => {
  const w = world();
  N.write(w.desk, 'Keep', 'k');
  N.write(w.desk, 'Old', 'o');
  w.pull(w.laptop);
  // Deleted on the laptop: the primary keeps it, and it doesn't come back to the laptop while unchanged.
  fs.rmSync(path.join(w.laptop.dir, 'Old.md'));
  w.round(w.laptop, 'Laptop');
  assert.equal(N.read(w.desk, 'Old'), 'o');
  assert.equal(fs.existsSync(path.join(w.laptop.dir, 'Old.md')), false);
  // Changed on the primary after that: it comes back, with that text.
  N.write(w.desk, 'Old', 'o, edited on the desk');
  w.pull(w.laptop);
  assert.equal(N.read(w.laptop.dir, 'Old'), 'o, edited on the desk');
  // Deleted (or renamed) on the primary: gone from the shared copy, kept on the laptop.
  N.rename(w.desk, 'Keep', 'Kept');
  w.round(w.laptop, 'Laptop');
  assert.equal(fs.existsSync(path.join(w.shared, 'Keep.md')), false);
  assert.equal(N.read(w.laptop.dir, 'Keep'), 'k');
  assert.equal(N.read(w.laptop.dir, 'Kept'), 'k');
});

test('bad names, odd files and anything over 5 MB are never taken in, and nothing is written outside the folder', () => {
  const w = world();
  const big = 'x'.repeat(N.MAX_TEXT + 1);
  const card = {
    '../escape': { text: 'no', base: null },
    'a/b': { text: 'no', base: null },
    'a\\b': { text: 'no', base: null },
    'C:\\Windows\\x': { text: 'no', base: null },
    CON: { text: 'no', base: null },
    '.hidden': { text: 'no', base: null },
    '  padded  ': { text: 'no', base: null },
    ['y'.repeat(81)]: { text: 'no', base: null },
    'not text': { text: 42, base: null },
    'no body': null,
    Huge: { text: big, base: null },
    Fine: { text: 'ok', base: null }
  };
  S.takeIn(w.desk, card, 'Laptop', {});
  assert.deepEqual(files(w.desk), ['Fine.md']);
  assert.deepEqual(files(path.dirname(w.desk)), ['Notebooks']);
  assert.equal(S.takeIn(w.desk, ['Fine'], 'x').changed, false);
  assert.equal(S.takeIn(w.desk, 'nonsense', 'x').changed, false);
  // A shared folder with things Kea wouldn't make: only the good notebook comes in.
  fs.mkdirSync(w.shared, { recursive: true });
  fs.writeFileSync(path.join(w.shared, 'Good.md'), 'good');
  fs.writeFileSync(path.join(w.shared, 'two..dots.md'), 'no');
  fs.writeFileSync(path.join(w.shared, 'notes.txt'), 'no');
  fs.writeFileSync(path.join(w.shared, 'émoji.md'), 'no');
  fs.writeFileSync(path.join(w.shared, 'Big.md'), big);
  fs.mkdirSync(path.join(w.shared, 'Folder.md'));
  S.pull(w.laptop.dir, w.shared, w.laptop.base, 'Desk');
  assert.deepEqual(files(w.laptop.dir), ['Good.md']);
  assert.deepEqual(files(path.dirname(w.laptop.dir)), ['Notebooks']);
  // A notebook here over the limit is never sent, nor written over.
  fs.writeFileSync(path.join(w.laptop.dir, 'Big.md'), big);
  assert.equal('Big' in S.outgoing(w.laptop.dir, w.laptop.base), false);
  N.write(w.desk, 'Big', 'small on the desk');
  S.publish(w.desk, w.shared);
  S.pull(w.laptop.dir, w.shared, w.laptop.base, 'Desk');
  assert.equal(fs.statSync(path.join(w.laptop.dir, 'Big.md')).size, big.length);
});

test('a clash copy’s name is always a valid notebook name, shortened to fit, numbered when taken', () => {
  assert.equal(S.deviceLabel('Ana’s PC #2'), 'Ana s PC 2');
  assert.equal(S.deviceLabel('???'), 'another device');
  const taken = new Set(['Notes (from Desk)']);
  assert.equal(S.copyName('Notes', 'Desk', (n) => taken.has(n)), 'Notes (from Desk 2)');
  const long = S.copyName('z'.repeat(80), 'A very long computer name indeed, really', () => false);
  assert.ok(long.length <= 80 && N.cleanName(long) === long, long);
  // (Shortening that leaves a dot at the end is fixed.)
  const dotted = S.copyName(`${'a'.repeat(60)}.b.c.d.e.f.g`, 'Desk', () => false);
  assert.equal(N.cleanName(dotted), dotted);
});

test('the phone copy lists every notebook, newest first, and leaves out the text past its budget', () => {
  const w = world();
  const t = Date.now() / 1000;
  N.write(w.desk, 'Small', 'hello');
  N.write(w.desk, 'Large', 'L'.repeat(S.PHONE_BUDGET));
  fs.utimesSync(path.join(w.desk, 'Small.md'), t - 100, t - 100);
  const list = S.forPhone(w.desk);
  assert.deepEqual(list.map((x) => x.name), ['Large', 'Small']);
  assert.equal(list[0].text.length, S.PHONE_BUDGET);
  assert.equal(list[1].text, null);
  assert.equal(list[1].tooBig, true);
  assert.deepEqual(S.forPhone(path.join(w.root, 'none')), []);
});

test('a save from the panel never writes over a change that arrived meanwhile: that text is kept beside it', () => {
  const w = world();
  N.write(w.desk, 'Open', 'as loaded');
  // Synced in while the panel had it open.
  N.write(w.desk, 'Open', 'from the laptop');
  const r = N.write(w.desk, 'Open', 'as loaded + typed', 'as loaded');
  assert.equal(r.kept, 'Open (changed elsewhere)');
  assert.equal(N.read(w.desk, 'Open'), 'as loaded + typed');
  assert.equal(N.read(w.desk, 'Open (changed elsewhere)'), 'from the laptop');
  // Nothing changed meanwhile (or no base given): a plain save.
  assert.equal(N.write(w.desk, 'Open', 'again', 'as loaded + typed').kept, null);
  assert.equal(N.write(w.desk, 'Open', 'and again').kept, null);
  assert.deepEqual(files(w.desk), ['Open (changed elsewhere).md', 'Open.md']);
});

test('notebook paths, clash copies included, pass the Kea cloud sync’s path rules unchanged', () => {
  for (const name of ['Bio ch 4 (cells)', 'Exam 2 (from Desk)', 'a_b-c.d', S.copyName('Notes', 'Kaden’s PC', () => false)]) {
    const rel = `Devices/shared/study/Notebooks/${name}.md`;
    assert.equal(hubsync.safeLocal(hubsync.toRemote(rel)), rel);
    assert.equal(hubsync.skipName(`${name}.md`), false);
  }
});
