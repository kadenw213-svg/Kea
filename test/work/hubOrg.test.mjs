// Work mode's main-process bridge (electron/hubOrg.cjs): only org routes reach the Hub, the calendar file, and the
// copy of shifts kept for when the Hub can't be reached. With a KeaS checkout beside this one, also a live round trip.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerAndSignIn } from '../hubRegister.mjs';
import { ofetch } from '../ownerFetch.mjs';
const APP = { senderFrame: { url: 'app://kea/index.html', parent: null } }; // a call from Kea's own page

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const HUB = ['../../../KeaS/hub/index.mjs', '../../../orgs-keas/hub/index.mjs'].map((p) => path.resolve(here, p)).find((p) => fs.existsSync(p));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-work-'));
const handlers = {};
const sent = [];
let signedInAs = null;
let hubReq = async (method, p, body) => {
  sent.push({ method, p, body });
  return { events: [] };
};
// Stand-ins for Electron and hub.cjs.
const fakeElectron = { app: { getPath: () => dir }, ipcMain: { handle: (n, f) => (handlers[n] = f) }, dialog: {}, BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }, shell: {} };
const load = Module._load;
Module._load = function (req, parent, ...rest) {
  if (req === 'electron') return fakeElectron;
  if (req === './hub.cjs' && parent?.filename?.endsWith('hubOrg.cjs')) return { req: (...a) => hubReq(...a), cached: () => signedInAs };
  return load.call(this, req, parent, ...rest);
};
const hubOrg = require('../../electron/hubOrg.cjs');
hubOrg.register();
const call = (method, p, body) => handlers['hubOrg:call'](APP, { method, path: p, body });

let hub;
after(async () => {
  Module._load = load;
  if (hub) await hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('only org routes go to the Hub', async () => {
  for (const p of ['/v1/orgs', '/v1/orgs/abc/forms', '/v1/orgs/join', '/v1/todo', '/v1/todo/snooze', '/v1/orgs-calendar?from=x', '/v1/calendar']) {
    const r = await call(p.includes('join') || p.includes('snooze') ? 'POST' : 'GET', p, {});
    assert.equal(r.ok, true, p);
  }
  for (const [m, p] of [['GET', '/v1/me'], ['GET', '/v1/files/kea/x'], ['POST', '/v1/auth/logout'], ['GET', '/v1/orgs/../me'], ['DELETE', '/v1/orgs'], ['GET', '/v1/orgsX'], ['GET', 'http://evil/v1/orgs']]) {
    const r = await call(m, p);
    assert.equal(r.ok, false, `${m} ${p}`);
  }
  assert.ok(sent.every((s) => s.p.startsWith('/v1/orgs') || s.p.startsWith('/v1/todo') || s.p.startsWith('/v1/calendar')));
});

test('calendar file: one event per shift, times in UTC, text escaped', () => {
  const ics = hubOrg.toIcs([{ id: 'shift:1', title: 'Lifeguard', orgName: 'Westside, Pool', start: '2026-12-01T11:45:00.000Z', end: '2026-12-01T16:00:00.000Z', location: 'Pool; deck' }]);
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20261201T114500Z\r\n/);
  assert.match(ics, /SUMMARY:Lifeguard \(Westside\\, Pool\)\r\n/);
  assert.match(ics, /LOCATION:Pool\\; deck\r\n/);
  assert.equal(ics.match(/BEGIN:VEVENT/g).length, 1);
});

test('calendar file: line breaks in any field (meeting link included) never start a new property or event', () => {
  const evil = 'x\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Pay here\rATTACH:https://evil.example/a\nX';
  const ics = hubOrg.toIcs([
    { id: `shift:1${evil}`, title: `Lifeguard${evil}`, orgName: `Pool${evil}`, start: '2026-12-01T11:45:00.000Z', end: '2026-12-01T16:00:00.000Z', location: `Deck;${evil}`, meetingUrl: `https://meet.jit.si/room${evil}` },
    { id: 'shift:2', title: 'Swim', orgName: 'Pool', start: '2026-12-02T11:45:00.000Z', end: '2026-12-02T16:00:00.000Z', meetingUrl: 'javascript:alert(1)' },
    { id: 'shift:3', title: 'Swim', orgName: 'Pool', start: '2026-12-03T11:45:00.000Z', end: '2026-12-03T16:00:00.000Z', meetingUrl: 'https://meet.jit.si/a,b;c' }
  ]);
  // Unfold, then every line is a known property: no injected END/BEGIN/ATTACH.
  const lines = ics.replace(/\r\n /g, '').split('\r\n').filter(Boolean);
  assert.equal(lines.filter((l) => l === 'BEGIN:VEVENT').length, 3);
  assert.equal(lines.filter((l) => l === 'END:VEVENT').length, 3);
  for (const l of lines) assert.match(l, /^(BEGIN|END|VERSION|PRODID|CALSCALE|UID|DTSTAMP|DTSTART|DTEND|SUMMARY|LOCATION|URL):/, l);
  assert.ok(!/[\r\n]/.test(ics.replace(/\r\n/g, '')), 'no bare CR or LF');
  assert.ok(lines.some((l) => l.startsWith('SUMMARY:Lifeguardx\\nEND:VEVENT\\nBEGIN:VEVENT\\nSUMMARY:Pay here\\nATTACH:https://evil.example/a\\nX')));
  // Only https meeting links, written as the parsed address (the line break and spaces percent-encoded or dropped).
  const urls = lines.filter((l) => l.startsWith('URL:'));
  assert.equal(urls.length, 2);
  assert.ok(urls.every((u) => /^URL:https:\/\/meet\.jit\.si\/\S+$/.test(u)), urls.join(' | '));
  // Long lines are folded at 75 octets.
  assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75));
});

test('shifts are kept on this PC for when the Hub is unreachable', async () => {
  const ev = { id: 'shift:9', kind: 'shift', orgId: 'o', orgName: 'Pool', title: 'Lifeguard', start: '2026-12-02T12:00:00.000Z', end: '2026-12-02T16:00:00.000Z', date: '2026-12-02' };
  hubReq = async () => ({ events: [ev] });
  const live = await handlers['hubOrg:events'](APP, { from: '2026-12-01T00:00:00Z', to: '2026-12-31T00:00:00Z' });
  assert.deepEqual([live.ok, live.value.offline, live.value.events.length], [true, false, 1]);
  hubReq = async () => { throw Object.assign(new Error("Can't reach the Kea Hub"), { status: 0 }); };
  const off = await handlers['hubOrg:events'](APP, { from: '2026-12-01T00:00:00Z', to: '2026-12-31T00:00:00Z' });
  assert.deepEqual([off.ok, off.value.offline, off.value.events[0].id], [true, true, 'shift:9']);
  hubReq = async () => { throw Object.assign(new Error('Sign in again.'), { status: 401 }); };
  assert.equal((await handlers['hubOrg:events'](APP, {})).ok, false, 'other errors are not hidden');
});

test('the saved shifts belong to the account that fetched them', async () => {
  const ev = { id: 'shift:7', kind: 'shift', orgId: 'o', orgName: 'Pool', title: 'Lifeguard', start: '2026-12-03T12:00:00.000Z', end: '2026-12-03T16:00:00.000Z', date: '2026-12-03' };
  const range = { from: '2026-12-01T00:00:00Z', to: '2026-12-31T00:00:00Z' };
  signedInAs = { id: 'ana' };
  hubReq = async () => ({ events: [ev] });
  await handlers['hubOrg:events'](APP, range);
  hubReq = async () => { throw Object.assign(new Error("Can't reach the Kea Hub"), { status: 0 }); };
  assert.deepEqual((await handlers['hubOrg:events'](APP, range)).value.events.map((e) => e.id), ['shift:7']);
  // Someone else signed in on this PC, offline: nothing of Ana's.
  signedInAs = { id: 'max' };
  assert.deepEqual((await handlers['hubOrg:events'](APP, range)).value.events, []);
  signedInAs = null;
});

test('live: make an org, join it with a code, see it in the to-do box', { skip: !HUB && 'No KeaS checkout beside this one' }, async () => {
  const { createHub } = await import(pathToFileURL(HUB).href);
  hub = createHub({ dataDir: path.join(dir, 'hub'), log: false });
  const p = await hub.listen({ port: 0, ownerPort: 0 });
  const base = `http://127.0.0.1:${p.port}`;
  const t = (await (await fetch(`${base}/v1/terms`)).json()).terms;
  const reg = async (email) => {
    const r = await (await registerAndSignIn(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'lantern velvet orbit', displayName: email.split('@')[0], age13: true, termsVersion: t.version, termsSections: t.sections.map((s) => s.id) }) })).json();
    await ofetch(`http://127.0.0.1:${p.ownerPort}/owner/accounts/${email}`, { method: 'POST', headers: { 'x-kea-owner-key': hub.ownerKey, 'content-type': 'application/json' }, body: '{"emailVerified":true}' });
    return r.token;
  };
  const tokens = { mgr: await reg('mgr@example.com'), emp: await reg('emp@example.com') };
  let who = 'mgr';
  // hub.cjs's req, signed in as whoever "this Kea" is.
  hubReq = async (method, path_, body) => {
    const r = await fetch(base + path_, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status, data: j });
    return j;
  };
  await ofetch(`http://127.0.0.1:${p.ownerPort}/owner/orgs/settings`, { method: 'POST', headers: { 'x-kea-owner-key': hub.ownerKey, 'content-type': 'application/json' }, body: '{"autoApprove":true}' });
  const org = (await call('POST', '/v1/orgs', { name: 'Pine Hollow Camp', tz: 'America/Chicago', state: 'TX' })).value.org;
  assert.equal(org.status, 'active');
  const code = (await call('POST', `/v1/orgs/${org.id}/codes`, { role: 'member' })).value.code.code;
  await call('POST', `/v1/orgs/${org.id}/forms`, { periodStart: '2027-06-07', periodEnd: '2027-06-13', blocks: [{ weekday: 1, start: '08:00', end: '17:00' }], open: true });
  who = 'emp';
  const joined = await call('POST', '/v1/orgs/join', { code: code.toLowerCase() });
  assert.equal(joined.value.org.name, 'Pine Hollow Camp');
  const todo = (await call('GET', '/v1/todo')).value.items;
  assert.ok(todo.some((i) => i.kind === 'availability'));
  const refused = await call('POST', `/v1/orgs/${org.id}/codes`, {});
  assert.deepEqual([refused.ok, refused.status], [false, 403]);
  assert.equal((await call('POST', `/v1/orgs/${org.id}/leave`, {})).ok, true);
});
