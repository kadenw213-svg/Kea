// Work against the org engine with custom roles and the time clock (a KeaS checkout with org/, e.g. KeaS-wt-org beside
// this one, or KEAS_ORG_DIR): the abilities Kea reads, the Roles editor's calls, and the time clock's, sent through
// electron/hubOrg.cjs exactly as the screens send them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerAndSignIn } from '../hubRegister.mjs';
import { ofetch } from '../ownerFetch.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = [process.env.KEAS_ORG_DIR, ...['../../../KeaS-wt-org', '../../../KeaS'].map((p) => path.resolve(here, p))].find((p) => p && fs.existsSync(path.join(p, 'org', 'clock.mjs')) && fs.existsSync(path.join(p, 'hub', 'index.mjs')));
const APP = { senderFrame: { url: 'app://kea/index.html', parent: null } };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-orgengine-'));
let hub = null;
after(async () => {
  if (hub) await hub.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('roles and the time clock, through Work’s bridge', { skip: !ROOT && 'No KeaS org engine beside this one' }, async (t) => {
  let createHub;
  try {
    ({ createHub } = await import(pathToFileURL(path.join(ROOT, 'hub', 'index.mjs')).href));
  } catch (e) {
    return t.skip(`The KeaS checkout doesn’t load right now: ${e.message}`);
  }
  hub = createHub({ dataDir: path.join(dir, 'hub'), log: false });
  const p = await hub.listen({ port: 0, ownerPort: 0 });
  const base = `http://127.0.0.1:${p.port}`;
  const owner = (pth, body) => ofetch(`http://127.0.0.1:${p.ownerPort}${pth}`, { method: 'POST', headers: { 'x-kea-owner-key': hub.ownerKey, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const terms = (await (await fetch(`${base}/v1/terms`)).json()).terms;
  const reg = async (email) => {
    const r = await (await registerAndSignIn(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'lantern velvet orbit', displayName: email.split('@')[0], age13: true, termsVersion: terms.version, termsSections: terms.sections.map((s) => s.id) }) })).json();
    await owner(`/owner/accounts/${email}`, { emailVerified: true });
    return r.token;
  };
  await owner('/owner/orgs/settings', { autoApprove: true });
  const tokens = { boss: await reg('boss@example.com'), lee: await reg('lee@example.com') };
  let who = 'boss';
  const handlers = {};
  const load = Module._load;
  Module._load = function (req, parent, ...rest) {
    if (req === 'electron') return { app: { getPath: () => dir }, ipcMain: { handle: (n, f) => (handlers[n] = f) }, dialog: {}, BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }, shell: {} };
    if (req === './hub.cjs' && parent?.filename?.endsWith('hubOrg.cjs'))
      return {
        signedIn: () => true,
        cached: () => ({ id: who }),
        req: async (method, pth, body) => {
          const r = await fetch(base + pth, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` }, body: body === undefined ? undefined : JSON.stringify(body) });
          const j = await r.json();
          if (!r.ok) throw Object.assign(new Error(j.error), { status: r.status, data: j });
          return j;
        },
      };
    if (req === './servers.cjs' && parent?.filename?.endsWith('hubOrg.cjs')) return { list: () => [], req: () => Promise.reject(new Error('none')) };
    return load.call(this, req, parent, ...rest);
  };
  delete require.cache[require.resolve('../../electron/hubOrg.cjs')];
  require('../../electron/hubOrg.cjs').register();
  Module._load = load;
  const call = async (method, pth, body) => {
    const r = await handlers['hubOrg:call'](APP, { method, path: pth, body });
    if (!r.ok) throw Object.assign(new Error(r.error), { status: r.status });
    return r.value;
  };

  const org = (await call('POST', '/v1/orgs', { name: 'Westside Pool', tz: 'America/Denver', state: 'CO' })).org;
  const dept = (await call('POST', `/v1/orgs/${org.id}/departments`, { name: 'Aquatics' })).department;
  const code = (await call('POST', `/v1/orgs/${org.id}/codes`, { role: 'member', departmentId: dept.id })).code.code;
  who = 'lee';
  await call('POST', '/v1/orgs/join', { code });
  // What Work reads: the list, then each organization's abilities.
  const list = await call('GET', '/v1/orgs');
  assert.deepEqual(list.orgs.map((o) => [o.name, o.server]), [['Westside Pool', null]]);
  let me = (await call('GET', `/v1/orgs/${org.id}`)).me;
  assert.deepEqual([...me.abilities].sort(), ['clock.self', 'timeoff.request']);
  const leeId = me.id;

  // The Roles editor: make a role, tick abilities, give it for one department.
  who = 'boss';
  const cat = await call('GET', `/v1/orgs/${org.id}/roles`);
  assert.ok(cat.abilities.some((a) => a.id === 'timecards.approve' && a.label));
  assert.deepEqual(cat.roles.filter((r) => r.template).map((r) => r.templateKey), ['owner', 'admin', 'manager', 'member']);
  const role = (await call('POST', `/v1/orgs/${org.id}/roles`, { name: 'Shift lead', abilities: [] })).role;
  await call('POST', `/v1/orgs/${org.id}/roles/${role.id}`, { abilities: ['schedule.view', 'timecards.view'] });
  const given = await call('POST', `/v1/orgs/${org.id}/members/${leeId}/roles`, { roleId: role.id, scope: [dept.id] });
  assert.ok(given.roles.some((r) => r.roleId === role.id && Array.isArray(r.scope) && r.scope[0] === dept.id));
  const people = await call('GET', `/v1/orgs/${org.id}/members`);
  assert.ok(people.members.find((m) => m.id === leeId).roles.some((r) => r.name === 'Shift lead'), 'People shows each person’s roles');
  who = 'lee';
  me = (await call('GET', `/v1/orgs/${org.id}`)).me;
  assert.deepEqual(me.scopes['timecards.view'], [dept.id]);
  assert.equal(me.role, 'member', 'the fixed role stays a summary');

  // The time clock.
  assert.equal((await call('GET', `/v1/orgs/${org.id}/clock`)).canClock, true);
  const inn = await call('POST', `/v1/orgs/${org.id}/clock`, { type: 'in', source: 'app' });
  assert.equal(inn.punch.type, 'in');
  assert.equal((await call('GET', `/v1/orgs/${org.id}/clock`)).clockedIn, true);
  await call('POST', `/v1/orgs/${org.id}/clock`, { type: 'out', source: 'app' });
  const tc = await call('GET', `/v1/orgs/${org.id}/timecards?periodStart=${(await call('GET', `/v1/orgs/${org.id}/clock`)).period.start}`);
  assert.ok(tc.days.some((d) => d.punches.length === 2));
  const off = (await call('POST', `/v1/orgs/${org.id}/time-off`, { kind: 'vacation', startDate: '2027-01-04', endDate: '2027-01-05', hours: null })).timeOff;
  assert.equal(off.status, 'pending');

  // The owner approves: time off, and the timecard for the period.
  who = 'boss';
  const pend = (await call('GET', `/v1/orgs/${org.id}/time-off?status=pending`)).timeOff;
  assert.deepEqual(pend.map((x) => x.id), [off.id]);
  assert.equal((await call('POST', `/v1/orgs/${org.id}/time-off/${off.id}/decide`, { approve: true })).timeOff.status, 'approved');
  const period = await call('GET', `/v1/orgs/${org.id}/timecards/period?periodStart=${tc.period.start}`);
  assert.ok(period.people.some((x) => x.accountId === leeId));
  const ok = await call('POST', `/v1/orgs/${org.id}/timecards/approve-many`, { accountIds: [leeId], periodStart: tc.period.start });
  assert.equal(ok.results[0].ok, true);
  // Taking the role back.
  await call('POST', `/v1/orgs/${org.id}/members/${leeId}/roles/${role.id}/delete`, {});
  who = 'lee';
  assert.equal((await call('GET', `/v1/orgs/${org.id}`)).me.abilities.includes('timecards.view'), false);
});
