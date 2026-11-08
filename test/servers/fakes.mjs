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
export async function fakeKeaC({ account = { id: 'acct-ana', email: 'ana@example.com', name: 'Ana' }, session = 'keac-session', features = ['pass'], passDays = 7 } = {}) {
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
