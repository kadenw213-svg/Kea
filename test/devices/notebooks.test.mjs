// Study notebooks through device sync (electron/scholar/devices.cjs with notebookSync.cjs): another computer brings in
// the primary's notebooks and sends its own in its card; the primary takes those in and shares its own; a clash keeps
// both; a folder of one's own (Settings → Study, Advanced) doesn't sync; an older primary's folder (no notebooks in
// it) changes nothing here.
// Run: node --test test/devices/
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('../worker/electronStub.cjs');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-devices-nb-test-'));
electron._paths.userData = path.join(base, 'user');
electron._paths.appData = path.join(base, 'user');
fs.mkdirSync(electron._paths.userData, { recursive: true });

const settings = require('../../electron/settings.cjs');
const profiles = require('../../electron/scholar/profiles.cjs');
const devices = require('../../electron/scholar/devices.cjs');
const N = require('../../electron/scholar/notebooks.cjs');
devices.configure({ readState: () => ({}), writeState() {}, applyMarks: () => false, syncSoon() {}, ready: async () => false, banks() {} });

after(() => fs.rmSync(base, { recursive: true, force: true }));

const drive = path.join(base, 'drive');
const name = () => profiles.all().list.find((p) => p.id === profiles.active())?.name || profiles.active();
const devDir = () => path.join(drive, 'Kea', name(), 'Devices');
const sharedNb = () => path.join(devDir(), 'shared', 'study', 'Notebooks');
const mine = () => path.join(profiles.paths().dir, 'study', 'Notebooks');
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const card = (id) => JSON.parse(fs.readFileSync(path.join(devDir(), 'devices', `${id}.json`), 'utf8'));
const files = (d) => (fs.existsSync(d) ? fs.readdirSync(d).sort() : []);

/** "Owner-PC" is the primary this computer already follows. */
function followOwner() {
  settings.set({ 'scholar.lastPrimary': 'other123' });
  const dir = devDir();
  fs.mkdirSync(path.join(dir, 'devices'), { recursive: true });
  const db = Buffer.from('THEIR CLASSES');
  fs.writeFileSync(path.join(dir, 'classes.db'), db);
  fs.writeFileSync(path.join(dir, 'primary.json'), JSON.stringify({ id: 'other123', name: 'Owner-PC', at: new Date().toISOString(), db: { size: db.length, sha: sha1(db) } }));
  fs.writeFileSync(path.join(dir, 'devices', 'other123.json'), JSON.stringify({ id: 'other123', name: 'Owner-PC', at: new Date().toISOString() }));
}

beforeEach(() => {
  fs.rmSync(drive, { recursive: true, force: true });
  fs.mkdirSync(drive, { recursive: true });
  fs.rmSync(path.join(electron._paths.userData, 'profiles'), { recursive: true, force: true });
  settings.set({ 'scholar.cloud': 'custom', 'scholar.cloudPath': drive, 'scholar.pcId': 'mine0001', 'scholar.deviceName': 'New-PC', 'scholar.lastPrimary': null, 'scholar.pcSync': null, 'study.notebook.folder': null });
});

test('another computer brings in the primary’s notebooks and sends its own; a clash keeps both', async () => {
  followOwner();
  N.write(sharedNb(), 'Bio', 'from the owner');
  N.write(mine(), 'Mine', 'written here');
  await devices.step();
  assert.equal(N.read(mine(), 'Bio'), 'from the owner');
  let nb = card('mine0001').marks.notebooks;
  assert.deepEqual(Object.keys(nb), ['Mine'], 'only what the primary doesn’t have yet goes out');
  assert.deepEqual(nb.Mine, { text: 'written here', base: null });
  // Both change Bio before the next round.
  N.write(sharedNb(), 'Bio', 'owner edit');
  N.write(mine(), 'Bio', 'my edit');
  await devices.step();
  assert.equal(N.read(mine(), 'Bio'), 'my edit');
  assert.equal(N.read(mine(), 'Bio (from Owner-PC)'), 'owner edit');
  nb = card('mine0001').marks.notebooks;
  assert.deepEqual(nb.Bio, { text: 'my edit', base: sha1('owner edit') }, 'its text goes out, started from the owner’s');
  assert.equal(nb['Bio (from Owner-PC)'].text, 'owner edit');
});

test('an older primary (no notebooks in its folder) changes nothing here', async () => {
  followOwner();
  N.write(mine(), 'Mine', 'written here');
  await devices.step();
  assert.deepEqual(files(mine()), ['Mine.md']);
  assert.equal(N.read(mine(), 'Mine'), 'written here');
});

test('a notebook folder of one’s own doesn’t sync, either way', async () => {
  followOwner();
  const own = path.join(base, 'own notebooks');
  settings.set({ 'study.notebook.folder': own });
  N.write(sharedNb(), 'Bio', 'from the owner');
  N.write(own, 'Private', 'stays here');
  await devices.step();
  assert.deepEqual(card('mine0001').marks.notebooks, {});
  assert.deepEqual(files(own), ['Private.md']);
  assert.equal(fs.existsSync(path.join(mine(), 'Bio.md')), false);
  assert.equal(devices.notebookDir(), null);
});

test('the primary shares its notebooks and takes in another computer’s, checking their names', async () => {
  fs.mkdirSync(path.dirname(profiles.paths().db), { recursive: true });
  fs.writeFileSync(profiles.paths().db, 'MY CLASSES');
  N.write(mine(), 'Exam 1', 'primary text');
  await devices.step();
  assert.equal(devices.status().role, 'primary');
  assert.equal(N.read(sharedNb(), 'Exam 1'), 'primary text');
  // A laptop's card: a new notebook, a clash, and names Kea would never make.
  fs.writeFileSync(
    path.join(devDir(), 'devices', 'lap00002.json'),
    JSON.stringify({
      id: 'lap00002',
      name: 'Laptop',
      at: new Date().toISOString(),
      marks: {
        notebooks: {
          'From laptop': { text: 'new there', base: null },
          'Exam 1': { text: 'laptop text', base: sha1('older text') },
          '../../escape': { text: 'no', base: null },
          'nul': { text: 'no', base: null }
        }
      }
    })
  );
  await devices.step();
  assert.equal(N.read(mine(), 'From laptop'), 'new there');
  assert.equal(N.read(mine(), 'Exam 1'), 'primary text');
  assert.equal(N.read(mine(), 'Exam 1 (from Laptop)'), 'laptop text');
  assert.deepEqual(files(mine()), ['Exam 1 (from Laptop).md', 'Exam 1.md', 'From laptop.md']);
  assert.deepEqual(files(path.dirname(mine())).filter((f) => !f.endsWith('.json')), ['Notebooks']);
  // Shared on the next round.
  await devices.step();
  assert.deepEqual(files(sharedNb()), ['Exam 1 (from Laptop).md', 'Exam 1.md', 'From laptop.md']);
});
