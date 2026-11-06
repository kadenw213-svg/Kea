// The worker's side of the relay (electron/scholar/remote.cjs) against a real Kea Hub, with a stand-in for the
// student's Kea answering the calls the way hub.cjs does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const HUB = [process.env.KEAS_DIR && path.join(process.env.KEAS_DIR, 'hub/index.mjs'), path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../KeaS/hub/index.mjs')].find((p) => p && fs.existsSync(p)) || '';
const haveHub = fs.existsSync(HUB);

let hub, base, ownerPort, dir, student, jobId, remote, stop = false;
const api = (p, init = {}) => fetch(base + p, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${student}`, ...(init.headers || {}) } }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

before(async () => {
  if (!haveHub) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-relay-'));
  const { createHub } = await import(pathToFileURL(HUB).href);
  hub = createHub({ dataDir: path.join(dir, 'hub'), log: false, relayWaitMs: 500 });
  const p = await hub.listen({ port: 0, ownerPort: 0 });
  base = `http://127.0.0.1:${p.port}`;
  ownerPort = p.ownerPort;
  const t = (await (await fetch(`${base}/v1/terms`)).json()).terms;
  const reg = await fetch(`${base}/v1/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'student@example.com', password: 'lantern velvet orbit', displayName: 'Stu', age13: true, birthYear: 1995, termsVersion: t.version, termsSections: t.sections.map((s) => s.id) }) });
  student = (await reg.json()).token;
  await fetch(`http://127.0.0.1:${ownerPort}/owner/accounts/student@example.com`, { method: 'POST', headers: { 'x-kea-owner-key': hub.ownerKey, 'content-type': 'application/json' }, body: '{"emailVerified":true}' });

  // What hub.cjs requestScan() does: queue, upload job.json (address + profile name, no login), say it's ready.
  const q = await api('/v1/scan', { method: 'POST', body: JSON.stringify({ kind: 'initial_scan', course: { school: 'd2l.example.edu', code: 'all-classes', term: '2027-01', section: 'me' } }) });
  jobId = q.body.job.id;
  await fetch(`${base}/v1/files/${q.body.uploadTo}job.json`, { method: 'PUT', headers: { authorization: `Bearer ${student}` }, body: JSON.stringify({ home: 'https://d2l.example.edu/d2l/home', platform: 'd2l', profile: 'School' }) });
  await api(`/v1/scan/${jobId}/ready`, { method: 'POST', body: '{}' });
  const next = await (await fetch(`http://127.0.0.1:${ownerPort}/owner/scan/next`, { method: 'POST', headers: { 'x-kea-owner-key': hub.ownerKey } })).json();
  assert.equal(next.job.id, jobId);

  // The worker copy's environment, as the launcher sets it.
  fs.writeFileSync(path.join(dir, 'owner.key'), hub.ownerKey);
  process.env.KEA_WORKER_JOB = jobId;
  process.env.KEA_OWNER_KEY_FILE = path.join(dir, 'owner.key');
  process.env.KEA_HUB_OWNER_PORT = String(ownerPort);
  remote = require('../../electron/scholar/remote.cjs');

  // The student's Kea: polls for calls and answers them like hub.cjs relayOp (a fake class site).
  (async () => {
    while (!stop) {
      const r = await api(`/v1/scan/${jobId}/calls`);
      if (r.status !== 200) break;
      for (const c of r.body.calls) {
        let body;
        if (c.op === 'request') body = { ok: true, result: { status: 200, url: c.args.url, headers: { 'content-type': 'application/json' }, body64: Buffer.from(JSON.stringify({ Items: [{ OrgUnit: { Name: 'BIO 1112' } }] })).toString('base64') } };
        else if (c.op === 'status') body = { ok: true, result: { setUp: true, signedIn: true, home: 'https://d2l.example.edu/d2l/home', platform: 'd2l' } };
        else if (c.op === 'open') body = { ok: true, result: { title: 'Course Home', text: 'Week 1: Cells', links: [] } };
        else body = { ok: false, error: 'not allowed' };
        await api(`/v1/scan/${jobId}/calls/${c.id}/result`, { method: 'POST', body: JSON.stringify(body) });
      }
    }
  })();
});
after(async () => {
  if (!haveHub) return;
  stop = true;
  await hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the worker reads the job, and browses through the student’s Kea', { skip: !haveHub && 'KeaS repo not next to this one' }, async () => {
  const job = await remote.job();
  assert.deepEqual(job, { home: 'https://d2l.example.edu/d2l/home', platform: 'd2l', profile: 'School' });
  assert.equal(remote.active(), true);
  const st = await remote.status();
  assert.equal(st.signedIn, true);
  // A fetch comes back shaped like a Response, so Kea's own code (getJson, fetchText, download) works unchanged.
  const res = await remote.request('https://d2l.example.edu/d2l/api/lp/1.0/enrollments/myenrollments/');
  assert.equal(res.ok, true);
  assert.equal(res.headers.get('content-type'), 'application/json');
  assert.equal((await res.json()).Items[0].OrgUnit.Name, 'BIO 1112');
  assert.equal(Buffer.from(await res.arrayBuffer()).length > 10, true);
  assert.equal((await remote.open('https://d2l.example.edu/d2l/home/1')).title, 'Course Home');
  await assert.rejects(remote.click('Submit'), /not allowed/);
});

test('the worker is the student’s primary: it writes their Kea folder, which their Kea then follows', { skip: !haveHub && 'KeaS repo not next to this one' }, async () => {
  const { createSync } = require('../../electron/scholar/hubsync.cjs');
  const root = path.join(dir, 'worker', 'hub-sync');
  const sync = createSync({ root, stateFile: path.join(dir, 'worker', 'state.json'), client: remote.syncClient(), now: () => Date.now() + 10_000 });
  fs.mkdirSync(path.join(root, 'Kea', 'School', 'Devices'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Kea', 'School', 'Devices', 'primary.json'), '{"id":"worker"}');
  fs.writeFileSync(path.join(root, 'Kea', 'School', 'kea-data.json'), '{"courses":[]}');
  const c = await sync.cycle();
  assert.equal(c.up, 2);
  const theirs = await api('/v1/files?prefix=kea/');
  assert.deepEqual(theirs.body.files.map((f) => f.path).sort(), ['kea/Kea/School/Devices/primary.json', 'kea/Kea/School/kea-data.json']);

  // Done: the job closes, the upload is cleaned away, and the worker can't reach their folder any more.
  await remote.finish(true, 'import done');
  assert.equal((await api('/v1/files?prefix=scan-inbox/')).body.files.length, 0);
  await assert.rejects(remote.syncClient().list(0), /No running job/);
  const jobs = await api('/v1/scan');
  assert.equal(jobs.body.jobs[0].status, 'done');
});
