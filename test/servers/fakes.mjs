// A small fake Kea account server (KeaC) and fake KeaS, doing exactly what protocol section 2 says, for testing Kea's
// side of server passes (electron/serversCore.cjs, electron/hubOrg.cjs). Plain node:http and node:crypto Ed25519.
import http from 'node:http';
import crypto from 'node:crypto';

const b64url = (b) => Buffer.from(b).toString('base64url');
const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((ok) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => {
      try {
        ok(s ? JSON.parse(s) : {});
      } catch {
        ok({});
      }
    });
  });
const bearer = (req) => /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1] ?? null;

function listen(handler) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((e) => json(res, 500, { error: String(e.message || e) }));
  });
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => {
      const sockets = new Set();
      server.on('connection', (s) => (sockets.add(s), s.on('close', () => sockets.delete(s))));
      ok({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => (sockets.forEach((s) => s.destroy()), server.close(() => done()))),
      });
    })
  );
}

/** Sign a JWT-shaped token with EdDSA. */
function signJwt(payload, privateKey, kid) {
  const head = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid }));
  const body = b64url(JSON.stringify(payload));
  return `${head}.${body}.${b64url(crypto.sign(null, Buffer.from(`${head}.${body}`), privateKey))}`;
}
function verifyJwt(token, keys) {
  const [h, p, s] = String(token).split('.');
  if (!s) return null;
  let head, payload;
  try {
    head = JSON.parse(Buffer.from(h, 'base64url'));
    payload = JSON.parse(Buffer.from(p, 'base64url'));
  } catch {
    return null;
  }
  const k = keys.find((x) => x.kid === head.kid);
  if (!k || head.alg !== 'EdDSA') return null;
  const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: k.x }, format: 'jwk' });
  return crypto.verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url')) ? payload : null;
}

/**
 * The Kea account server: one account signed in with session `session`, /v1/health with features, /v1/pass, /v1/keys,
 * /v1/revoked. `features` without 'pass' acts like Hub 0.5 (no /v1/pass).
 */
export async function fakeKeaC({ account = { id: 'acct-ana', email: 'ana@example.com', name: 'Ana' }, session = 'keac-session', features = ['pass'], passDays = 7, extra = null } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const kid = 'k1';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig', status: 'current' };
  const state = { passes: [], revoked: new Set(), suspended: false, now: () => Date.now() };
  const srv = await listen(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/v1/health') return json(res, 200, { ok: true, service: 'keac', version: 'test', features });
    if (req.method === 'GET' && u.pathname === '/v1/keys') return json(res, 200, { keys: [jwk] });
    if (req.method === 'GET' && u.pathname === '/v1/revoked') return json(res, 200, { now: state.now(), ids: [...state.revoked], full: true });
    if (req.method === 'POST' && u.pathname === '/v1/pass' && features.includes('pass')) {
      if (bearer(req) !== session || state.suspended) return json(res, 401, { error: 'Sign in again.' });
      const { serverId } = await readBody(req);
      if (typeof serverId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(serverId)) return json(res, 400, { error: 'Send serverId.' });
      const iat = Math.floor(state.now() / 1000);
      const exp = iat + passDays * 86400;
      const pass = signJwt({ iss: 'kea', aud: `keas:${serverId}`, sub: account.id, email: account.email, name: account.name, ev: true, iat, exp }, privateKey, kid);
      state.passes.push({ serverId, at: state.now() });
      return json(res, 200, { pass, exp });
    }
    // (More routes for trying Kea against it by hand: sign-in and /v1/me.)
    if (extra && (await extra(req, res, u, { json, readBody, bearer }))) return;
    return json(res, 404, { error: 'Not found.' });
  });
  return { ...srv, jwk, state, account, session, kid, privateKey, signJwt: (p) => signJwt(p, privateKey, kid) };
}

/**
 * A KeaS: its own Ed25519 identity, /v1/identity, /v1/auth/pass (checked against KeaC's keys, iss, aud, exp, iat,
 * revocation), its own sessions, and a tiny org engine (/v1/orgs, join, one org route, to-dos, calendar, files list).
 *   mode: 'ok' | 'wrongId' (serverId doesn't match its key) | 'badSig' (signs the wrong text)
 */
export async function fakeKeaS({ keys, name = 'Westside Pool', mode = 'ok', code = 'POOL-CODE-1234', sessionMs = 3600e3 } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.from(jwk.x, 'base64url');
  const serverId = b64url(crypto.createHash('sha256').update(raw).digest()).slice(0, 22);
  const state = { sessions: new Map(), revoked: new Set(), orgs: [{ id: `org-${serverId.slice(0, 6)}`, name, role: 'member', memberStatus: 'active', status: 'active', tz: 'America/Denver', members: 3 }], members: new Set(), passesSeen: 0, now: () => Date.now(), mode, abilities: ['clock.self', 'timeoff.request'], punches: [] };
  const signedIn = (req) => {
    const s = state.sessions.get(bearer(req));
    if (!s || s.exp < state.now() || state.revoked.has(s.sub)) return null;
    return s;
  };
  const srv = await listen(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    if (req.method === 'GET' && p === '/v1/identity') {
      const nonce = u.searchParams.get('nonce') || '';
      const id = state.mode === 'wrongId' ? serverId.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) : serverId;
      const text = state.mode === 'badSig' ? `kea-server-identity:${serverId}:not-${nonce}` : `kea-server-identity:${id}:${nonce}`;
      return json(res, 200, { serverId: id, publicKey: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, name, sig: b64url(crypto.sign(null, Buffer.from(text), privateKey)) });
    }
    if (req.method === 'POST' && p === '/v1/auth/pass') {
      const { pass } = await readBody(req);
      state.passesSeen++;
      const pl = verifyJwt(pass, keys());
      const t = Math.floor(state.now() / 1000);
      if (!pl || pl.iss !== 'kea' || pl.aud !== `keas:${serverId}` || !(pl.exp > t) || pl.iat > t + 120) return json(res, 401, { error: 'That pass isn’t good here.' });
      if (state.revoked.has(pl.sub)) return json(res, 401, { error: 'This account was signed out of this organization.' });
      const token = crypto.randomBytes(24).toString('hex');
      state.sessions.set(token, { sub: pl.sub, email: pl.email, name: pl.name, exp: state.now() + sessionMs });
      return json(res, 200, { token, me: { id: pl.sub, email: pl.email, name: pl.name } });
    }
    const s = signedIn(req);
    if (!s) return json(res, 401, { error: 'Sign in again.' });
    if (req.method === 'POST' && p === '/v1/orgs/join') {
      const b = await readBody(req);
      if (String(b.code).replace(/[^A-Z0-9]/gi, '').toUpperCase() !== code.replace(/[^A-Z0-9]/gi, '').toUpperCase()) return json(res, 404, { error: 'That join code isn’t right.' });
      state.members.add(s.sub);
      return json(res, 200, { org: state.orgs[0], alreadyMember: false });
    }
    if (!state.members.has(s.sub)) return json(res, 200, p === '/v1/orgs' ? { orgs: [] } : p === '/v1/todo' ? { now: state.now(), items: [], snoozed: [] } : { events: [] });
    const org = state.orgs[0];
    if (req.method === 'GET' && p === '/v1/orgs') return json(res, 200, { orgs: state.orgs });
    if (req.method === 'GET' && p === `/v1/orgs/${org.id}`) return json(res, 200, { org, me: { id: s.sub, role: 'member', abilities: state.abilities, scopes: Object.fromEntries(state.abilities.map((a) => [a, 'org'])), roles: [{ roleId: 'r-member', name: 'Member', templateKey: 'member', scope: 'org' }] } });
    if (req.method === 'GET' && p === `/v1/orgs/${org.id}/clock`) {
      const last = state.punches.filter((x) => x.sub === s.sub).at(-1);
      return json(res, 200, { clockedIn: last?.type === 'in', punch: last ?? null, canClock: true, period: { start: '2026-11-01', end: '2026-11-14' } });
    }
    if (req.method === 'POST' && p === `/v1/orgs/${org.id}/clock`) {
      const b = await readBody(req);
      const pu = { id: `p${state.punches.length + 1}`, sub: s.sub, type: b.type, at: new Date(state.now()).toISOString() };
      state.punches.push(pu);
      return json(res, 201, { punch: pu, shift: null, minutesLate: 0, late: false });
    }
    if (req.method === 'GET' && p === '/v1/todo') return json(res, 200, { now: state.now(), items: [{ key: `ack:${org.id}:1`, kind: 'ack', orgId: org.id, orgName: org.name, title: 'Read the pool rules', detail: '', dueAt: null, msLeft: null, overdue: false, urgency: 1, action: { type: 'ack' } }], snoozed: [] });
    if (req.method === 'GET' && p === '/v1/orgs-calendar') return json(res, 200, { events: [{ id: `shift:${serverId}`, kind: 'shift', orgId: org.id, orgName: org.name, title: 'Lifeguard', start: '2026-12-02T15:00:00.000Z', end: '2026-12-02T19:00:00.000Z', date: '2026-12-02' }] });
    return json(res, 404, { error: 'Not found.' });
  });
  return { ...srv, serverId, name, state, code, joinLink: (c = code) => `kea://join?s=${encodeURIComponent(srv.url)}&c=${encodeURIComponent(c)}` };
}

/**
 * A Kea account server that hosts organizations (protocol section 5): org routes take the account's own session (no
 * pass), /v1/health lists 'hostedOrgs', organizations come only from an approved application (POST /v1/apply; POST
 * /v1/orgs is refused), a suspended organization answers 403 and a removed one 404. Pay codes follow the org engine's
 * rules (KeaS org/paycodes.mjs): people see only their own codes (with rates) under me/pay; the organization's list and
 * other people's codes need paycodes.manage, paycodes.assign, rates.view, schedule.edit or timecards.approve, and rates
 * show only with rates.view (or paycodes.manage); a shift or punch takes only one of its person's codes.
 * Sessions: sess-ana (a member with codes), sess-bo (a manager without rates.view), sess-cy (an admin with rates.view,
 * paycodes.manage and paycodes.assign).
 *   features: what /v1/health lists (without 'hostedOrgs' and 'applications' it acts like an older account server)
 */
export async function fakeHostedKeaC({ features = ['passes', 'applications', 'hostedOrgs'] } = {}) {
  const accounts = {
    'sess-ana': { id: 'acct-ana', email: 'ana@example.com', name: 'Ana' },
    'sess-bo': { id: 'acct-bo', email: 'bo@example.com', name: 'Bo' },
    'sess-cy': { id: 'acct-cy', email: 'cy@example.com', name: 'Cy' },
  };
  const MEMBER = ['clock.self', 'timeoff.request'];
  const state = {
    sent: [],
    applications: [],
    orgs: [{ id: 'hosted-camp', name: 'Pine Hollow Camp', kind: 'employer', tz: 'America/Denver', status: 'active', code: 'CAMP-JOIN-2026' }],
    // account id -> { org id -> abilities }
    members: {
      'acct-ana': { 'hosted-camp': MEMBER },
      'acct-bo': { 'hosted-camp': [...MEMBER, 'people.view', 'schedule.edit', 'timecards.approve'] },
      'acct-cy': { 'hosted-camp': [...MEMBER, 'people.view', 'schedule.edit', 'rates.view', 'paycodes.manage', 'paycodes.assign'] },
    },
    codes: [
      { id: 'pc-guard', orgId: 'hosted-camp', name: 'Lifeguard', rateCents: 1500, color: '#2a7fff', active: true, departmentId: null },
      { id: 'pc-swim', orgId: 'hosted-camp', name: 'Swim instructor', rateCents: 1800, color: '#22aa55', active: true, departmentId: null },
      { id: 'pc-desk', orgId: 'hosted-camp', name: 'Front desk', rateCents: 1300, color: null, active: true, departmentId: null },
      { id: 'pc-old', orgId: 'hosted-camp', name: 'Old code', rateCents: 1000, color: null, active: false, departmentId: null },
    ],
    // account id -> [{ codeId, default }]
    grants: { 'acct-ana': [{ codeId: 'pc-guard', default: true }, { codeId: 'pc-swim', default: false }, { codeId: 'pc-old', default: false }] },
    shifts: [{ id: 'sh-1', orgId: 'hosted-camp', accountId: 'acct-ana', payCodeId: 'pc-guard', start: '2026-12-02T15:00:00.000Z', end: '2026-12-02T19:00:00.000Z' }],
    punches: [],
    stubs: null,
  };
  const me = (req) => accounts[bearer(req)] ?? null;
  const orgOf = (id) => state.orgs.find((o) => o.id === id) ?? null;
  const abil = (aid, oid) => state.members[aid]?.[oid] ?? null;
  const has = (aid, oid, a) => (abil(aid, oid) ?? []).includes(a);
  const codeOut = (c, rate) => ({ id: c.id, name: c.name, kind: 'hourly', color: c.color, active: c.active, departmentId: c.departmentId, ...(rate ? { rateCents: c.rateCents, rate: c.rateCents / 100 } : {}) });
  const personCodes = (aid, rate) =>
    (state.grants[aid] ?? []).map((g) => ({ ...codeOut(state.codes.find((x) => x.id === g.codeId), rate), default: g.default }));
  const granted = (aid, cid) => (state.grants[aid] ?? []).some((g) => g.codeId === cid);
  const pickFor = (aid, cid) => {
    const c = state.codes.find((x) => x.id === cid);
    if (!c) return 'That pay code is not in this organization.';
    if (!c.active) return `${c.name} is turned off. Pick another pay code.`;
    if (aid && !granted(aid, cid)) return 'That pay code wasn’t given to this person. Pick one of their codes.';
    return null;
  };
  const roleOf = (aid, oid) => (has(aid, oid, 'paycodes.manage') ? 'admin' : has(aid, oid, 'schedule.edit') ? 'manager' : 'member');
  const orgListOut = (o, aid) => ({ id: o.id, name: o.name, kind: o.kind, tz: o.tz, status: o.status, role: roleOf(aid, o.id), memberStatus: 'active', members: Object.keys(state.members).filter((x) => state.members[x][o.id]).length });
  const hosted = features.includes('hostedOrgs');
  const applies = features.includes('applications');

  const srv = await listen(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    state.sent.push(`${req.method} ${p}`);
    if (req.method === 'GET' && p === '/v1/health') return json(res, 200, { ok: true, service: 'keac', version: 'test', features });
    const a = me(req);
    if (!a) return json(res, 401, { error: 'Sign in again.' });
    if (p === '/v1/apply' && !applies) return json(res, 404, { error: 'Not found.' });
    if (req.method === 'GET' && p === '/v1/apply') {
      const mine = state.applications.filter((x) => x.accountId === a.id).map(({ accountId, ...x }) => x);
      return json(res, 200, { creator: false, applications: mine.sort((x, y) => y.createdAt - x.createdAt) });
    }
    if (req.method === 'POST' && p === '/v1/apply') {
      const b = await readBody(req);
      if (!['creator', 'hosting'].includes(b.kind)) return json(res, 400, { error: 'kind must be creator or hosting.' });
      if (state.applications.some((x) => x.accountId === a.id && x.kind === b.kind && x.status === 'pending')) return json(res, 400, { error: 'Your application is already waiting for review.' });
      if (b.kind === 'hosting' && (!['school', 'employer'].includes(b.orgKind) || String(b.name || '').trim().length < 2)) return json(res, 400, { error: 'Give the organization a name.' });
      if (b.kind === 'creator' && (String(b.note || '').trim().length < 10 || !String(b.organization || '').trim())) return json(res, 400, { error: 'Say what you will teach, and your organization.' });
      const x = { id: `app-${state.applications.length + 1}`, accountId: a.id, kind: b.kind, note: b.note ?? '', organization: b.organization ?? null, orgKind: b.orgKind ?? null, name: b.name ?? null, status: 'pending', createdAt: Date.now() + state.applications.length, decidedAt: null, decisionNote: null };
      state.applications.push(x);
      const { accountId, ...out } = x;
      return json(res, 201, { status: 'pending', application: out });
    }
    if (p.startsWith('/v1/orgs') && !hosted) return json(res, 404, { error: 'Not found.' });
    if (req.method === 'GET' && p === '/v1/orgs') return json(res, 200, { orgs: state.orgs.filter((o) => abil(a.id, o.id)).map((o) => orgListOut(o, a.id)) });
    if (req.method === 'POST' && p === '/v1/orgs') return json(res, 403, { error: 'Organizations hosted on Kea come from an approved application.' });
    if (req.method === 'POST' && p === '/v1/orgs/join') {
      const b = await readBody(req);
      const norm = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const o = state.orgs.find((x) => x.status === 'active' && norm(x.code) === norm(b.code));
      if (!o) return json(res, 404, { error: 'That join code isn’t right.' });
      const already = !!abil(a.id, o.id);
      (state.members[a.id] ??= {})[o.id] ??= MEMBER;
      return json(res, 200, { org: orgListOut(o, a.id), alreadyMember: already });
    }
    if (req.method === 'GET' && p === '/v1/todo') return json(res, 200, { now: Date.now(), items: [], snoozed: [] });
    if (req.method === 'GET' && p === '/v1/orgs-calendar') return json(res, 200, { events: [] });
    const m = /^\/v1\/orgs\/([^/]+)(\/.*)?$/.exec(p);
    if (!m) return json(res, 404, { error: 'Not found.' });
    const o = orgOf(m[1]);
    if (!o || !abil(a.id, o.id)) return json(res, 404, { error: 'Organization not found.' });
    if (o.status === 'suspended') return json(res, 403, { error: 'This organization is suspended on this server.' });
    const rest = m[2] ?? '';
    const can = (x) => has(a.id, o.id, x);
    const seesRate = () => can('paycodes.manage') || can('rates.view');
    if (req.method === 'GET' && rest === '') {
      const ab = abil(a.id, o.id);
      return json(res, 200, { org: { ...orgListOut(o, a.id), settings: {} }, me: { id: a.id, abilities: ab, scopes: Object.fromEntries(ab.map((x) => [x, 'org'])), roles: [{ roleId: 'r', name: 'Member', templateKey: 'member', scope: 'org' }] } });
    }
    if (req.method === 'GET' && rest === '/pay-codes') {
      if (!['paycodes.manage', 'paycodes.assign', 'rates.view', 'schedule.edit', 'timecards.approve'].some(can)) return json(res, 403, { error: 'Your own pay codes are under My pay.' });
      const holders = (c) => Object.values(state.grants).filter((g) => g.some((x) => x.codeId === c.id)).length;
      return json(res, 200, { codes: state.codes.filter((c) => c.orgId === o.id).map((c) => ({ ...codeOut(c, seesRate()), holders: holders(c) })), canManage: can('paycodes.manage'), canAssign: can('paycodes.assign'), canSeeRates: seesRate(), hasKey: true });
    }
    const mc = /^\/members\/([^/]+)\/pay-codes$/.exec(rest);
    if (req.method === 'GET' && mc) {
      const self = mc[1] === a.id;
      if (!self && !['paycodes.assign', 'rates.view', 'schedule.edit', 'timecards.approve'].some(can)) return json(res, 403, { error: 'You can only see your own pay codes.' });
      return json(res, 200, { accountId: mc[1], codes: personCodes(mc[1], self || seesRate()) });
    }
    if (req.method === 'GET' && rest === '/me/pay') {
      const codes = personCodes(a.id, true);
      return json(res, 200, {
        period: { start: '2026-11-01', end: '2026-11-14' }, current: { start: '2026-11-01', end: '2026-11-14' }, codes, defaultCodeId: codes.find((c) => c.default)?.id ?? null,
        hours: [], totals: { workedMin: 0, regularMin: 0, overtimeMin: 0, doubleTimeMin: 0 }, approved: null, note: 'Pay stubs come from payroll.', ...(state.stubs ? { stubs: state.stubs } : {}),
      });
    }
    if (req.method === 'GET' && rest.startsWith('/my-shifts')) return json(res, 200, { shifts: state.shifts.filter((s) => s.accountId === a.id).map((s) => ({ ...s, date: s.start.slice(0, 10), status: 'published' })) });
    const sc = /^\/shifts\/([^/]+)\/pay-code$/.exec(rest);
    if (req.method === 'POST' && sc) {
      const sh = state.shifts.find((s) => s.id === sc[1]);
      if (!sh) return json(res, 404, { error: 'Shift not found.' });
      if (sh.accountId !== a.id && !can('schedule.edit')) return json(res, 403, { error: 'You can’t change that shift.' });
      const b = await readBody(req);
      const why = pickFor(sh.accountId, b.payCodeId);
      if (why) return json(res, 400, { error: why });
      sh.payCodeId = b.payCodeId;
      return json(res, 200, { shiftId: sh.id, payCodeId: sh.payCodeId });
    }
    if (req.method === 'POST' && rest === '/clock') {
      const b = await readBody(req);
      let code = null;
      if (b.type === 'in') {
        if (b.payCodeId != null) {
          const why = pickFor(a.id, b.payCodeId);
          if (why) return json(res, 400, { error: why });
          code = b.payCodeId;
        } else code = (state.grants[a.id] ?? []).find((g) => g.default)?.codeId ?? null;
      }
      const pu = { id: `pu${state.punches.length + 1}`, accountId: a.id, type: b.type, at: new Date().toISOString(), payCodeId: code };
      state.punches.push(pu);
      return json(res, 201, { punch: pu, shift: null, minutesLate: 0, late: false });
    }
    if (req.method === 'GET' && rest.startsWith('/pay-feed')) return json(res, 200, { v: 1, people: [] });
    return json(res, 404, { error: 'Not found.' });
  });
  return {
    ...srv,
    state,
    accounts,
    /** The owner approves an application; a hosting one makes the organization at once, with the applicant as owner. */
    approve(appId) {
      const x = state.applications.find((y) => y.id === appId);
      Object.assign(x, { status: 'approved', decidedAt: Date.now() });
      if (x.kind !== 'hosting') return null;
      const o = { id: `hosted-${x.id}`, name: x.name, kind: x.orgKind, tz: 'America/Denver', status: 'active', code: `NEW-${x.id}`.toUpperCase() };
      state.orgs.push(o);
      (state.members[x.accountId] ??= {})[o.id] = [...MEMBER, 'people.view', 'schedule.edit', 'rates.view', 'paycodes.manage', 'paycodes.assign', 'structure.edit', 'settings.edit'];
      return o;
    },
    decline(appId, note = null) {
      Object.assign(state.applications.find((y) => y.id === appId), { status: 'declined', decidedAt: Date.now(), decisionNote: note });
    },
  };
}
