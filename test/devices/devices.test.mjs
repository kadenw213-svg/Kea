// Device sync never takes over a computer by itself (electron/scholar/devices.cjs): a profile that finds another
// device's classes in its drive folder keeps its own classes, writes nothing there, and only follows that device once
// the student confirms; a computer that already joined (scholar.lastPrimary) keeps following as before.
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
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-devices-test-'));
electron._paths.userData = path.join(base, 'user');
electron._paths.appData = path.join(base, 'user');
fs.mkdirSync(electron._paths.userData, { recursive: true });

const settings = require('../../electron/settings.cjs');
const profiles = require('../../electron/scholar/profiles.cjs');
const devices = require('../../electron/scholar/devices.cjs');
devices.configure({ readState: () => ({}), writeState() {}, applyMarks: () => false, syncSoon() {}, ready: async () => false, banks() {} });

after(() => fs.rmSync(base, { recursive: true, force: true }));

const drive = path.join(base, 'drive');
const name = () => profiles.all().list.find((p) => p.id === profiles.active())?.name || profiles.active();
const devDir = () => path.join(drive, 'Kea', name(), 'Devices');
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');

/** Another computer ("Owner-PC") shares its classes in the drive folder under this profile's name. */
function otherShares() {
  const dir = devDir();
  fs.mkdirSync(path.join(dir, 'devices'), { recursive: true });
  const db = Buffer.from('THEIR CLASSES');
  fs.writeFileSync(path.join(dir, 'classes.db'), db);
  fs.writeFileSync(path.join(dir, 'primary.json'), JSON.stringify({ id: 'other123', name: 'Owner-PC', at: new Date().toISOString(), db: { size: db.length, sha: sha1(db) } }));
  fs.writeFileSync(path.join(dir, 'devices', 'other123.json'), JSON.stringify({ id: 'other123', name: 'Owner-PC', at: new Date().toISOString() }));
  return dir;
}
const myDb = () => profiles.paths().db;
function myClasses() {
  fs.mkdirSync(path.dirname(myDb()), { recursive: true });
  fs.writeFileSync(myDb(), 'MY CLASSES');
}

beforeEach(() => {
  fs.rmSync(drive, { recursive: true, force: true });
  fs.mkdirSync(drive, { recursive: true });
  fs.rmSync(path.join(electron._paths.userData, 'profiles'), { recursive: true, force: true });
  settings.set({ 'scholar.cloud': 'custom', 'scholar.cloudPath': drive, 'scholar.pcId': 'mine0001', 'scholar.deviceName': 'New-PC', 'scholar.lastPrimary': null, 'scholar.pcSync': null });
});

test('a new profile that finds another computer’s classes keeps its own, writes nothing there and asks', async () => {
  myClasses();
  const dir = otherShares();
  await devices.step();
  assert.equal(fs.readFileSync(myDb(), 'utf8'), 'MY CLASSES');
  assert.equal(fs.existsSync(myDb().replace(/\.db$/, '.before-device-sync.db')), false);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'devices')), ['other123.json'], 'no device card of this computer in their folder');
  assert.equal(devices.follower(), false);
  assert.equal(devices.standsAside(), true);
  assert.equal(devices.publishes(), false, 'nor does it write the phone copy into their folder');
  assert.equal(settings.get('scholar.lastPrimary', ''), '');
  const st = devices.status();
  assert.equal(st.role, 'offer');
  assert.equal(st.offer.primary, 'Owner-PC');
  assert.equal(st.devices.length, 0);
  assert.throws(() => devices.makePrimary('mine0001'), /hasn’t joined/);
});

test('a profile with no classes of its own doesn’t join by itself either (not even one under another name)', async () => {
  otherShares();
  await devices.step();
  assert.equal(fs.existsSync(myDb()), false);
  assert.equal(devices.status().role, 'offer');
  // Another profile name in the same drive: offered, not joined.
  fs.rmSync(drive, { recursive: true, force: true });
  fs.mkdirSync(path.join(drive, 'Kea', 'Someone', 'Devices'), { recursive: true });
  fs.writeFileSync(path.join(drive, 'Kea', 'Someone', 'Devices', 'primary.json'), JSON.stringify({ id: 'x', name: 'Their-PC', at: new Date().toISOString() }));
  await devices.step();
  assert.equal(name() === 'Someone', false, 'the profile wasn’t renamed to theirs');
  assert.equal(settings.get('scholar.lastPrimary', ''), '');
});

test('joining needs the student’s confirmation; once confirmed it follows that computer', async () => {
  myClasses();
  const dir = otherShares();
  const share = devices.status().offer;
  await assert.rejects(devices.join(share), /confirm/);
  assert.equal(fs.readFileSync(myDb(), 'utf8'), 'MY CLASSES');
  const r = await devices.join({ ...share, confirmed: true });
  assert.equal(r.ok, true);
  assert.equal(r.from, 'Owner-PC');
  assert.equal(fs.readFileSync(myDb(), 'utf8'), 'THEIR CLASSES');
  assert.equal(fs.readFileSync(myDb().replace(/\.db$/, '.before-device-sync.db'), 'utf8'), 'MY CLASSES', 'its own classes are kept aside');
  assert.equal(settings.get('scholar.lastPrimary', ''), 'other123');
  assert.equal(devices.follower(), true);
  assert.ok(fs.existsSync(path.join(dir, 'devices', 'mine0001.json')));
  assert.equal(devices.status().role, 'follower');
});

test('a computer that already joined (lastPrimary set) keeps following exactly as before', async () => {
  settings.set({ 'scholar.lastPrimary': 'other123' });
  myClasses();
  otherShares();
  await devices.step();
  assert.equal(devices.follower(), true);
  assert.equal(fs.readFileSync(myDb(), 'utf8'), 'THEIR CLASSES');
  // A new primary chosen on another device of the group is followed too.
  const dir = devDir();
  const p = JSON.parse(fs.readFileSync(path.join(dir, 'primary.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'primary.json'), JSON.stringify({ ...p, id: 'third456', name: 'Laptop' }));
  assert.equal(devices.follower(), true);
  assert.equal(settings.get('scholar.lastPrimary', ''), 'third456');
});

test('the first computer with classes and nobody else in the folder becomes the primary', async () => {
  myClasses();
  await devices.step();
  const p = JSON.parse(fs.readFileSync(path.join(devDir(), 'primary.json'), 'utf8'));
  assert.equal(p.id, 'mine0001');
  assert.equal(devices.status().role, 'primary');
  assert.equal(devices.publishes(), true);
});

test('Kea’s shared Claude running this student’s own job is followed without asking', async () => {
  otherShares();
  const f = path.join(devDir(), 'primary.json');
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), worker: true, name: 'Kea’s shared Claude' }));
  await devices.step();
  assert.equal(devices.follower(), true);
  assert.equal(fs.readFileSync(myDb(), 'utf8'), 'THEIR CLASSES');
});
