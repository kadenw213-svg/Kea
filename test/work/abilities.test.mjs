// Work's ability checks (src/components/work/types.ts): what the server sends (abilities and where they reach), and
// on a KeaS 0.5 Hub, the fixed role's abilities (the same lists the org engine starts its template roles with).
//   node --test test/work/
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
let T;
before(async () => {
  const out = path.join(os.tmpdir(), `kea-work-types-${process.pid}.cjs`);
  await require('esbuild').build({ entryPoints: [path.resolve(here, '../../src/components/work/types.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
  T = require(out);
  fs.rmSync(out, { force: true });
});

const org = (o) => ({ role: 'member', memberStatus: 'active', ...o });

test('a KeaS 0.5 Hub: the fixed role decides', () => {
  assert.equal(T.can(org({ role: 'manager' }), 'schedule.edit'), true);
  assert.equal(T.can(org({ role: 'manager' }), 'structure.edit'), false);
  assert.equal(T.can(org({ role: 'admin' }), 'structure.edit', null), true);
  assert.equal(T.can(org({ role: 'member' }), 'people.view'), false);
  assert.equal(T.can(org({ role: 'owner' }), 'anything.new'), true);
  assert.equal(T.can(org({ role: 'manager', memberStatus: 'pending' }), 'schedule.edit'), false, 'nothing while waiting to be let in');
  assert.equal(T.hasRoles(org({})), false);
});

test('a server with custom roles: abilities and where they reach', () => {
  const o = org({ role: 'member', abilities: ['clock.self', 'schedule.edit', 'people.view'], scopes: { 'clock.self': 'org', 'schedule.edit': ['pool', 'pool-swim'], 'people.view': 'org' } });
  assert.equal(T.hasRoles(o), true);
  assert.equal(T.can(o, 'schedule.edit'), true, 'somewhere');
  assert.equal(T.can(o, 'schedule.edit', 'pool-swim'), true, 'in a department it reaches');
  assert.equal(T.can(o, 'schedule.edit', 'front-desk'), false);
  assert.equal(T.can(o, 'schedule.edit', null), false, 'not for the whole organization');
  assert.equal(T.can(o, 'people.view', 'front-desk'), true);
  assert.equal(T.can(o, 'clock.self', 'anywhere'), true);
  assert.equal(T.can(o, 'structure.edit'), false, 'the role says member, but abilities decide');
  assert.equal(T.canAny(o, ['roles.manage', 'people.view']), true);
  // An ability listed without a scope counts for the whole organization.
  assert.equal(T.can(org({ abilities: ['timecards.view'] }), 'timecards.view', 'x'), true);
  assert.equal(T.can(org({ role: 'owner', abilities: [] }), 'people.view'), false, 'the list is what counts');
});

test('the controls for changing someone: never myself, and not people above me', () => {
  const mgr = org({ role: 'manager' });
  assert.equal(T.mayChange(mgr, { role: 'member', you: false, departmentId: null }), true);
  assert.equal(T.mayChange(mgr, { role: 'admin', you: false, departmentId: null }), false);
  assert.equal(T.mayChange(mgr, { role: 'member', you: true, departmentId: null }), false);
  const lead = org({ role: 'member', abilities: ['people.edit'], scopes: { 'people.edit': ['pool'] } });
  assert.equal(T.mayChange(lead, { role: 'member', you: false, departmentId: 'pool' }), true);
  assert.equal(T.mayChange(lead, { role: 'member', you: false, departmentId: 'desk' }), false);
  assert.equal(T.mayChange(lead, { role: 'owner', you: false, departmentId: 'pool' }), false);
  assert.equal(T.mayChange(org({ role: 'owner' }), { role: 'owner', you: false, departmentId: null }), true);
});

const ROLES = [process.env.KEAS_DIR && path.join(process.env.KEAS_DIR, 'org/roles.mjs'), ...['../../../KeaS-wt-org/org/roles.mjs', '../../../KeaS/org/roles.mjs'].map((p) => path.resolve(here, p))].find((p) => p && fs.existsSync(p));
// (The engine's templates may have abilities added since, for things a KeaS 0.5 Hub doesn't have: pay codes.)
test('the fixed roles’ abilities are in the org engine’s templates', { skip: !ROLES && 'No KeaS org engine beside this one' }, async () => {
  const R = await import(pathToFileURL(ROLES).href);
  for (const t of R.TEMPLATES.filter((x) => x.key !== 'owner')) {
    const extra = T.ROLE_ABILITIES[t.key].filter((a) => !t.abilities.includes(a));
    assert.deepEqual(extra, [], t.key);
    assert.ok(t.abilities.filter((a) => !T.ROLE_ABILITIES[t.key].includes(a)).every((a) => !(a in R.ABILITIES) || !/^(people|schedule|clock|timecards|timeoff|roles|structure|settings|certs|classes|forms|swaps|policies|budgets|codes)\./.test(a)), t.key);
  }
});
