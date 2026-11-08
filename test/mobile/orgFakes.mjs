// A small fake Kea account server (KeaC) and fake KeaS doing what protocol sections 2 and 5 say, and a stand-in for
// the phone's native org side (Orgs.java: passes and sessions kept away from the app's code), for testing the phone's
// Work client (mobile/src/orgCore.ts). Adapted from Kea on the computer's test/servers/fakes.mjs. Plain node:http
// and node:crypto Ed25519; nothing real is reached.
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

/** One clock for everything in a test (servers, the stand-in phone and the client). */
export const clock = { t: Date.parse('2026-12-01T16:00:00Z'), now() { return this.t; }, add(ms) { this.t += ms; } };

function listen(handler, state) {
  const server = http.createServer((req, res) => {
    // (Down: the connection just drops, as when the phone has no signal or the server is off.)
    if (state.down) return req.socket.destroy();
    Promise.resolve(handler(req, res)).catch((e) => json(res, 500, { error: String(e.message || e) }));
  });
  return new Promise((ok) =>
    server.listen(0, '127.0.0.1', () => {
      const sockets = new Set();
      server.on('connection', (s) => (sockets.add(s), s.on('close', () => sockets.delete(s))));
      ok({
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => (sockets.forEach((s) => s.destroy()), server.close(() => done())))
      });
    })
  );
}

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

/** A tiny org engine (one organization) behind `who(req)`: the routes the phone's Work tab uses. */
function orgEngine({ state, org }) {
  return async (req, res, u, sub) => {
    const p = u.pathname;
    const m = req.method;
    if (m === 'POST' && p === '/v1/orgs/join') {
      const b = await readBody(req);
      if (String(b.code).replace(/[^A-Z0-9]/gi, '').toUpperCase() !== state.code.replace(/[^A-Z0-9]/gi, '').toUpperCase()) return json(res, 404, { error: 'That code doesn’t work. Check it, or ask for a new one.' }), true;
      state.members.add(sub);
      return json(res, 200, { org: { ...org, role: 'member', memberStatus: 'active' }, alreadyMember: false }), true;
    }
    if (!state.members.has(sub)) {
      if (p === '/v1/orgs') return json(res, 200, { orgs: [] }), true;
      if (p === '/v1/todo') return json(res, 200, { now: clock.now(), items: [], snoozed: [] }), true;
      return json(res, 404, { error: 'Not found.' }), true;
    }
    const base = `/v1/orgs/${org.id}`;
    if (m === 'GET' && p === '/v1/orgs') return json(res, 200, { orgs: [{ ...org, role: state.role, memberStatus: 'active' }] }), true;
    if (m === 'GET' && p === base) {
      const meOut = { id: sub, role: state.role, status: 'active' };
      if (state.abilities) Object.assign(meOut, { abilities: state.abilities, scopes: Object.fromEntries(state.abilities.map((a) => [a, 'org'])), roles: [] });
      return json(res, 200, { org: { ...org, role: state.role, memberStatus: 'active' }, me: meOut }), true;
    }
    if (m === 'GET' && p === `${base}/my-shifts`) {
      const shifts = state.shifts.map((s) => ({ ...s, swap: null }));
      return json(res, 200, { shifts }), true;
    }
    if (m === 'GET' && p === `${base}/clock`) {
      const last = state.punches.filter((x) => x.sub === sub).at(-1);
      return json(res, 200, { clockedIn: last?.type === 'in', punch: last ?? null, canClock: true, period: { start: '2026-11-29', end: '2026-12-12' }, defaultPayCodeId: 'pc-reg' }), true;
    }
    if (m === 'POST' && p === `${base}/clock`) {
      const b = await readBody(req);
      const pu = { id: `p${state.punches.length + 1}`, sub, type: b.type, at: new Date(clock.now()).toISOString(), payCodeId: b.payCodeId ?? 'pc-reg', source: b.source };
      state.punches.push(pu);
      return json(res, 201, { punch: pu, shift: null, minutesLate: 0, late: false }), true;
    }
    if (m === 'GET' && p === '/v1/todo') return json(res, 200, { now: clock.now(), items: [{ key: `ack:${org.id}:1`, kind: 'ack', orgId: org.id, orgName: org.name, title: state.todoTitle, detail: '', dueAt: null, msLeft: null, overdue: false, urgency: 1, action: { type: 'ack', policyId: 'pol1' } }], snoozed: [] }), true;
    return false;
  };
}
/** A published shift starting `inHours` from now (the test clock's now when the server starts). */
const shiftAt = (id, inHours, hours, positionName) => {
  const startAt = clock.now() + inHours * 3600e3;
  return { id, scheduleId: 'sc1', accountId: null, positionId: 'pos1', positionName, date: new Date(startAt).toISOString().slice(0, 10), start: new Date(startAt).toISOString(), end: new Date(startAt + hours * 3600e3).toISOString(), startAt, endAt: startAt + hours * 3600e3, status: 'published', note: null };
};

/**
 * The Kea account server: one account signed in with session `session`, /v1/health with features, /v1/pass, /v1/keys,
 * /v1/revoked, and (with 'hostedOrgs') one hosted organization on the account session itself.
 */
export async function fakeKeaC({ account = { id: 'acct-ana', email: 'ana@example.com', name: 'Ana' }, session = 'keac-session', features = ['pass', 'hostedOrgs'], passDays = 7 } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const kid = 'k1';
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid, alg: 'EdDSA', use: 'sig', status: 'current' };
  const org = { id: 'org-hosted', name: 'Riverside Library', tz: 'America/Denver', status: 'active', members: 4 };
  const state = { passes: [], down: false, suspended: false, code: 'LIBRARY-CODE-99', members: new Set(), role: 'member', abilities: ['clock.self', 'timeoff.request'], shifts: [shiftAt('lib-1', 48, 3, 'Desk')], punches: [], todoTitle: 'Read the library rules' };
  const engine = orgEngine({ state, org });
  const srv = await listen(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET' && u.pathname === '/v1/health') return json(res, 200, { ok: true, service: 'keac', version: 'test', features });
    if (req.method === 'GET' && u.pathname === '/v1/keys') return json(res, 200, { keys: [jwk] });
    const signed = bearer(req) === session && !state.suspended;
    if (req.method === 'POST' && u.pathname === '/v1/pass' && features.includes('pass')) {
      if (!signed) return json(res, 401, { error: 'Sign in again.' });
      const { serverId } = await readBody(req);
      if (typeof serverId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(serverId)) return json(res, 400, { error: 'Send serverId.' });
      const iat = Math.floor(clock.now() / 1000);
      const exp = iat + passDays * 86400;
      const aud = state.wrongAud ? 'keas:AAAAAAAAAAAAAAAAAAAAAA' : `keas:${serverId}`;
      const pass = signJwt({ iss: 'kea', aud, sub: account.id, email: account.email, name: account.name, ev: true, iat, exp }, privateKey, kid);
      state.passes.push({ serverId, at: clock.now() });
      return json(res, 200, { pass, exp });
    }
    if (features.includes('hostedOrgs') && /^\/v1\/(orgs|todo)/.test(u.pathname)) {
      if (!signed) return json(res, 401, { error: 'Sign in again.' });
      if (await engine(req, res, u, account.id)) return;
    }
    return json(res, 404, { error: 'Not found.' });
  }, state);
  return { ...srv, jwk, state, account, session, org };
}

/**
 * A KeaS: its own Ed25519 identity, /v1/identity, /v1/auth/pass (checked against KeaC's keys, iss, aud, exp, iat,
 * revocation), its own sessions, and the tiny org engine.
 *   mode: 'ok' | 'wrongId' (serverId doesn't match its key) | 'badSig' (signs the wrong text)
 */
export async function fakeKeaS({ keys, name = 'Westside Pool', mode = 'ok', code = 'POOL-CODE-1234', sessionMs = 3600e3 } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.from(jwk.x, 'base64url');
  const serverId = b64url(crypto.createHash('sha256').update(raw).digest()).slice(0, 22);
  const org = { id: `org-${serverId.slice(0, 6)}`, name, tz: 'America/Denver', status: 'active', members: 3 };
  const state = {
    sessions: new Map(), revoked: new Set(), members: new Set(), passesSeen: 0, mode, down: false, code, role: 'member', abilities: ['clock.self', 'timeoff.request'],
    shifts: [shiftAt('pool-1', 24, 4, 'Lifeguard'), shiftAt('pool-2', 72, 4, 'Lifeguard')], punches: [], todoTitle: 'Read the pool rules'
  };
  const engine = orgEngine({ state, org });
  const srv = await listen(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    if (req.method === 'GET' && p === '/v1/identity') {
      const nonce = u.searchParams.get('nonce') || '';
      const id = state.mode === 'wrongId' ? serverId.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')) : serverId;
      const text = state.mode === 'badSig' ? `kea-server-identity:${serverId}:not-${nonce}` : `kea-server-identity:${id}:${nonce}`;
      const key = state.otherKey ? state.otherKey : { x: jwk.x, priv: privateKey, id: serverId };
      if (state.otherKey) return json(res, 200, { serverId: key.id, publicKey: { kty: 'OKP', crv: 'Ed25519', x: key.x }, name, sig: b64url(crypto.sign(null, Buffer.from(`kea-server-identity:${key.id}:${nonce}`), key.priv)) });
      return json(res, 200, { serverId: id, publicKey: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, name, sig: b64url(crypto.sign(null, Buffer.from(text), privateKey)) });
    }
    if (req.method === 'POST' && p === '/v1/auth/pass') {
      const { pass } = await readBody(req);
      state.passesSeen++;
      const pl = verifyJwt(pass, keys());
      const t = Math.floor(clock.now() / 1000);
      if (!pl || pl.iss !== 'kea' || pl.aud !== `keas:${serverId}` || !(pl.exp > t) || pl.iat > t + 120) return json(res, 401, { error: 'That pass isn’t good here.' });
      if (state.revoked.has(pl.sub)) return json(res, 401, { error: 'This account was signed out of this organization.' });
      const token = crypto.randomBytes(24).toString('hex');
      state.sessions.set(token, { sub: pl.sub, exp: clock.now() + sessionMs });
      return json(res, 200, { token, exp: clock.now() + sessionMs, me: { id: pl.sub, email: pl.email, name: pl.name } });
    }
    const s = state.sessions.get(bearer(req));
    if (!s || s.exp < clock.now() || state.revoked.has(s.sub)) return json(res, 401, { error: 'Sign in again.' });
    if (await engine(req, res, u, s.sub)) return;
    return json(res, 404, { error: 'Not found.' });
  }, state);
  /** Another key at the same address (the server was replaced). */
  const replaceKey = () => {
    const k = crypto.generateKeyPairSync('ed25519');
    const x = k.publicKey.export({ format: 'jwk' }).x;
    state.otherKey = { x, priv: k.privateKey, id: b64url(crypto.createHash('sha256').update(Buffer.from(x, 'base64url')).digest()).slice(0, 22) };
  };
  return { ...srv, serverId, name, state, org, code, replaceKey, joinLink: (c = code) => `kea://join?s=${encodeURIComponent(srv.url)}&c=${encodeURIComponent(c)}` };
}

/**
 * The phone's native org side, as Orgs.java does it: servers, passes and sessions kept here (never handed back),
 * identity checked with Ed25519 (`check`: 'native' like Android 13+, or 'unavailable' like older Android, leaving the
 * signature to WebCrypto), a pass sent only to an address just checked for that id and only when made for it.
 */
export function fakePhone({ keac, check = 'native' }) {
  const rec = new Map();
  const checked = new Map();
  const seenByApp = [];
  const k = (a, id) => `${a}|${id}`;
  const http1 = async (url, method, path, body, token) => {
    const r = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ?? undefined, signal: AbortSignal.timeout(3000) });
    return { status: r.status, body: await r.text() };
  };
  const view = (e) => ({ serverId: e.serverId, url: e.url, name: e.name, joinedAt: e.joinedAt, signedOut: !!e.signedOut, message: e.message ?? null, passAt: e.passAt ?? null, passExp: e.passExp ?? null, hasPass: !!e.pass, hasToken: !!e.token });
  const out = (x) => (seenByApp.push(JSON.stringify(x)), x);
  const payload = (pass) => {
    try {
      return JSON.parse(Buffer.from(String(pass).split('.')[1], 'base64url').toString());
    } catch {
      return null;
    }
  };
  const phone = {
    rec,
    seenByApp,
    accountSession: keac.session,
    async orgList({ account }) {
      return out({ servers: [...rec.values()].filter((e) => e.account === account).map(view) });
    },
    async orgIdentity({ url }) {
      const nonce = crypto.randomBytes(16).toString('hex');
      const r = await http1(url, 'GET', `/v1/identity?nonce=${nonce}`);
      let verdict = 'bad';
      try {
        const a = JSON.parse(r.body);
        const raw = Buffer.from(a.publicKey.x, 'base64url');
        const id = b64url(crypto.createHash('sha256').update(raw).digest()).slice(0, 22);
        if (raw.length === 32 && id === a.serverId) {
          if (check === 'unavailable') verdict = 'unavailable';
          else {
            const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: a.publicKey.x }, format: 'jwk' });
            verdict = crypto.verify(null, Buffer.from(`kea-server-identity:${id}:${nonce}`), key, Buffer.from(a.sig, 'base64url')) ? 'ok' : 'bad';
          }
          if (verdict !== 'bad') checked.set(url, { id, at: clock.now() });
        }
      } catch {}
      return out({ ...r, nonce, check: verdict });
    },
    async orgAdd({ account, url, serverId, name }) {
      const c = checked.get(url);
      if (!c || c.id !== serverId) throw new Error('Kea hasn’t checked this server’s identity.');
      if (!rec.has(k(account, serverId))) rec.set(k(account, serverId), { account, url, serverId, name, joinedAt: clock.now() });
    },
    async orgUpdate({ account, serverId, ...patch }) {
      const e = rec.get(k(account, serverId));
      if (e) for (const key of ['name', 'signedOut', 'message']) if (key in patch) e[key] = patch[key];
    },
    async orgRemove({ account, serverId }) {
      rec.delete(k(account, serverId));
    },
    async orgDropSession({ account, serverId }) {
      const e = rec.get(k(account, serverId));
      if (e) delete e.token;
    },
    async orgFetchPass({ account, serverId }) {
      const e = rec.get(k(account, serverId));
      if (!e) throw new Error('This server isn’t one of yours on this phone.');
      const r = await http1(keac.url, 'POST', '/v1/pass', JSON.stringify({ serverId }), phone.accountSession);
      if (r.status < 200 || r.status >= 300) return out(r);
      const j = JSON.parse(r.body);
      if (payload(j.pass)?.aud !== `keas:${serverId}`) return out({ status: 502, body: JSON.stringify({ error: 'wrong', wrongAudience: true }) });
      const exp = j.exp < 1e12 ? j.exp * 1000 : j.exp;
      Object.assign(e, { pass: j.pass, passExp: exp, passAt: clock.now() });
      return out({ status: r.status, body: JSON.stringify({ exp }), exp });
    },
    async orgSignIn({ account, serverId }) {
      const e = rec.get(k(account, serverId));
      if (!e) throw new Error('This server isn’t one of yours on this phone.');
      if (!e.pass) return out({ status: 401, body: '{"noPass":true}' });
      const c = checked.get(e.url);
      if (!c || c.id !== serverId || clock.now() - c.at > 600e3) return out({ status: 495, body: '{"identity":false}' });
      const r = await http1(e.url, 'POST', '/v1/auth/pass', JSON.stringify({ pass: e.pass }));
      if (r.status >= 200 && r.status < 300) {
        const j = JSON.parse(r.body);
        e.token = j.token;
        delete j.token;
        return out({ status: r.status, body: JSON.stringify(j) });
      }
      return out(r);
    },
    async orgRequest({ account, serverId, method, path, body }) {
      const e = rec.get(k(account, serverId));
      if (!e) throw new Error('This server isn’t one of yours on this phone.');
      if (!e.token) return out({ status: 401, body: '{"noSession":true}' });
      return out(await http1(e.url, method, path, method === 'GET' ? undefined : body, e.token));
    }
  };
  return phone;
}

/** The account side for the client: this phone's account, online or not, and requests to KeaC with its session. */
export function fakeAccount(keac, { key = 'local-ana', online = true } = {}) {
  const a = {
    key: () => a.k,
    k: key,
    on: online,
    online: () => a.on,
    // (Offline: what the server said last time, as orgs.ts keeps it.)
    last: false,
    hosted: async () => {
      const r = await fetch(`${keac.url}/v1/health`, { signal: AbortSignal.timeout(3000) }).then((x) => x.json()).catch(() => null);
      if (r) a.last = !!r.features?.includes('hostedOrgs');
      return a.last;
    },
    async req(method, path, body) {
      let r;
      try {
        r = await fetch(keac.url + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${keac.session}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000) });
      } catch {
        throw Object.assign(new Error('Can’t reach your Kea account online right now.'), { status: 0, data: { unreachable: true } });
      }
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(d.error || `HTTP ${r.status}`), { status: r.status, data: d });
      return d;
    }
  };
  return a;
}

export function memStore() {
  const m = new Map();
  return { m, get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => void m.set(k, String(v)), remove: (k) => void m.delete(k) };
}
