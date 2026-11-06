// Two devices syncing their Kea folder through a real Kea Hub (from the KeaS repo next to this one).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerAndSignIn } from '../hubRegister.mjs';

const require = createRequire(import.meta.url);
const { createSync, httpClient, encodeSeg, decodeSeg } = require('../../electron/scholar/hubsync.cjs');
const HUB = [process.env.KEAS_DIR && path.join(process.env.KEAS_DIR, 'hub/index.mjs'), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../KeaS/hub/index.mjs')].find((p) => p && fs.existsSync(p)) || '';
const haveHub = fs.existsSync(HUB);

let hub, base, dir, token;
before(async () => {
  if (!haveHub) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-hubsync-'));
  const { createHub } = await import(pathToFileURL(HUB).href);
  hub = createHub({ dataDir: path.join(dir, 'hub'), log: false, defaultQuotaBytes: 1024 ** 3 });
  const p = await hub.listen({ port: 0, ownerPort: 0 });
  base = `http://127.0.0.1:${p.port}`;
  const t = (await (await fetch(`${base}/v1/terms`)).json()).terms;
  const r = await registerAndSignIn(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'me@example.com', password: 'lantern velvet orbit', displayName: 'Me', age13: true, birthYear: 1995, termsVersion: t.version, termsSections: t.sections.map((s) => s.id) }) });
  token = (await r.json()).token;
});
after(async () => {
  if (!haveHub) return;
  await hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// Each device: its own folder and state. ("now" runs 10 s ahead so freshly written files count as settled.)
function device(name) {
  const root = path.join(dir, name, 'hub-sync');
  const s = createSync({ root, stateFile: path.join(dir, name, 'state.json'), client: httpClient({ base: () => base, token: () => token, fetchFn: fetch }), now: () => Date.now() + 10_000 });
  const w = (rel, text) => (fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }), fs.writeFileSync(path.join(root, rel), text));
  const r = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const has = (rel) => fs.existsSync(path.join(root, rel));
  return { root, s, w, r, has, full: () => (s.state().fullAt = 0) };
}

test('names the Hub does not allow survive the round trip', () => {
  for (const n of ['Ch 1 #cells [v2].pdf', 'a~b.json', 'Quiz: 3?.json', 'ünïcode ok.txt']) assert.equal(decodeSeg(encodeSeg(n)), n);
  assert.equal(encodeSeg('kea-data.json'), 'kea-data.json');
});

test('two devices stay in step through the Hub', { skip: !haveHub && 'KeaS repo not next to this one' }, async () => {
  const A = device('A'), B = device('B');
  A.w('School/kea-data.json', '{"v":1}');
  A.w('School/Devices/primary.json', '{"id":"A"}');
  A.w('School/Textbooks/BIO 101/Ch 1 #cells [v2].pdf', '%PDF fake');
  let c = await A.s.cycle();
  assert.equal(c.up, 3);
  c = await B.s.cycle();
  assert.equal(c.down, 3);
  assert.equal(B.r('School/Textbooks/BIO 101/Ch 1 #cells [v2].pdf'), '%PDF fake');

  // Nothing changed: nothing moves.
  const before = { ...(await A.s.cycle()) };
  assert.deepEqual([before.up, before.down], [3, 0]);

  // B writes its own card; A sees it. A changes the data; B gets only that.
  B.w('School/Devices/devices/B.json', '{"marks":[1]}');
  await B.s.cycle();
  A.w('School/kea-data.json', '{"v":2}');
  await A.s.cycle();
  assert.equal(A.r('School/Devices/devices/B.json'), '{"marks":[1]}');
  await B.s.cycle();
  assert.equal(B.r('School/kea-data.json'), '{"v":2}');

  // A request: B makes it, A (the primary) takes it in and deletes it; it disappears from B too.
  B.w('School/Devices/requests/1-B.json', '{"task":"daily"}');
  await B.s.cycle();
  await A.s.cycle();
  assert.ok(A.has('School/Devices/requests/1-B.json'));
  fs.rmSync(path.join(A.root, 'School/Devices/requests/1-B.json'));
  await A.s.cycle();
  B.full();
  await B.s.cycle();
  assert.equal(B.has('School/Devices/requests/1-B.json'), false);

  // Both change the same file before syncing: the one that syncs last keeps its change, and both end up equal.
  A.w('School/Devices/primary.json', '{"id":"A","at":2}');
  B.w('School/Devices/primary.json', '{"id":"B","at":3}');
  await A.s.cycle();
  await B.s.cycle();
  await A.s.cycle();
  assert.equal(A.r('School/Devices/primary.json'), B.r('School/Devices/primary.json'));
  assert.equal(B.r('School/Devices/primary.json'), '{"id":"B","at":3}');
});

test('a folder that vanishes does not wipe the Hub', { skip: !haveHub && 'KeaS repo not next to this one' }, async () => {
  const C = device('C');
  for (let i = 0; i < 30; i++) C.w(`Other/Devices/shared/study/sets/s${i}.json`, `{"i":${i}}`);
  await C.s.cycle();
  fs.rmSync(C.root, { recursive: true, force: true });
  await C.s.cycle();
  const list = await (await fetch(`${base}/v1/files?prefix=kea/Other/`, { headers: { authorization: `Bearer ${token}` } })).json();
  assert.equal(list.files.length, 30);
});
