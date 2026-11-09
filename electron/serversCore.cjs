// KeaS servers this Kea account has joined, and signing in to them with a server pass (protocol section 2).
//
//   1. The server proves who it is: GET <keas>/v1/identity?nonce=<n> answers { serverId, publicKey (JWK), name, sig },
//      sig = Ed25519 over "kea-server-identity:<serverId>:<nonce>", and serverId = base64url(sha256(raw key))[0..22].
//      Kea remembers the id on joining; a server at the same address with another id is refused from then on.
//   2. Kea asks the Kea account server for a pass for that id: POST <keac>/v1/pass { serverId } -> { pass, exp }.
//   3. Kea hands the pass to the server: POST <keas>/v1/auth/pass { pass } -> { token } (the server's own session).
//   4. The pass is renewed once a day while online. While the account server can't be reached, Kea keeps using the
//      pass and server session it has. A server that answers 401 to a fresh pass has signed this account out.
//
// Join links: kea://join?s=<server address>&c=<join code> (both URL-encoded). Under Advanced, the address and the
// code can be typed in separately.
//
// No Electron here (electron/servers.cjs wires it up), so the tests run it against a fake account server and KeaS.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DAY = 864e5;
const PASS_RENEW_MS = 20 * 3600e3; // a pass older than this is renewed (about once a day)
const LIMITS = { req: 8000 };

class ServerError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data ?? null;
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** serverId for a raw 32-byte Ed25519 public key. */
const serverIdOf = (raw) => b64url(crypto.createHash('sha256').update(raw).digest()).slice(0, 22);

/** A server address Kea will talk to: https anywhere, plain http only to this computer. Returns its origin. */
function cleanUrl(input) {
  const s = String(input ?? '').trim();
  if (!s) throw new ServerError('Enter the server’s address.', 400);
  let u;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    throw new ServerError('That isn’t a server address. It looks like https://name.example.org', 400);
  }
  if (!/^https?:$/.test(u.protocol)) throw new ServerError('Use an https:// address.', 400);
  if (u.protocol === 'http:' && !/^(127\.\d+\.\d+\.\d+|localhost|\[::1\])$/i.test(u.hostname)) throw new ServerError('Use the server’s https:// address. Plain http only works for a server on this computer.', 400);
  return u.origin;
}

/**
 * What someone pasted or typed to join: a join link (kea://join?s=...&c=...), or { address, code } from Advanced.
 * A bare code (no server) returns { url: null, code }: that's a code for the Kea account server's own organizations.
 */
function parseJoin(input) {
  if (input && typeof input === 'object') {
    const code = String(input.code ?? '').trim();
    if (!code) throw new ServerError('Enter the join code.', 400);
    return { url: input.address ? cleanUrl(input.address) : null, code };
  }
  const s = String(input ?? '').trim();
  if (/^kea:\/\//i.test(s)) {
    let u;
    try {
      u = new URL(s);
    } catch {
      throw new ServerError('That join link isn’t complete. Copy the whole link again.', 400);
    }
    // (kea://join?... parses with host "join"; kea:join?... with path "join".)
    const what = (u.host || u.pathname.replace(/^\/+/, '')).toLowerCase();
    if (what !== 'join') throw new ServerError('That isn’t a join link.', 400);
    const server = u.searchParams.get('s');
    const code = (u.searchParams.get('c') || '').trim();
    if (!server || !code) throw new ServerError('That join link isn’t complete. Copy the whole link again.', 400);
    return { url: cleanUrl(server), code };
  }
  if (!s) throw new ServerError('Enter the join code.', 400);
  return { url: null, code: s };
}
/** The join link for a server and code. */
const joinLink = (url, code) => `kea://join?s=${encodeURIComponent(cleanUrl(url))}&c=${encodeURIComponent(String(code).trim())}`;

/** A JWT-shaped pass's payload, without checking it (Kea only reads aud and exp; the server checks the signature). */
function passPayload(pass) {
  try {
    const p = String(pass).split('.');
    if (p.length !== 3) return null;
    return JSON.parse(unb64url(p[1]).toString('utf8'));
  } catch {
    return null;
  }
}
/** exp in ms, whether the server sent seconds (JWT style) or ms. */
const asMs = (t) => (t == null ? null : Number(t) < 1e12 ? Number(t) * 1000 : Number(t));

/**
 * Checks a server's answer to /v1/identity for `nonce`. Returns { serverId, name, publicKey } or throws (status 495:
 * the server couldn't prove who it is).
 */
function checkIdentity(answer, nonce, expectId = null) {
  const refuse = (why) => {
    throw new ServerError(`This server couldn’t prove who it is, so Kea didn’t connect (${why}).`, 495, { identity: false });
  };
  const a = answer && typeof answer === 'object' ? answer : {};
  const jwk = a.publicKey;
  if (!jwk || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') refuse('no Ed25519 key');
  const raw = unb64url(jwk.x);
  if (raw.length !== 32) refuse('a key of the wrong length');
  const id = serverIdOf(raw);
  if (a.serverId !== id) refuse('its id doesn’t match its key');
  let ok = false;
  try {
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' });
    ok = crypto.verify(null, Buffer.from(`kea-server-identity:${id}:${nonce}`), key, unb64url(a.sig || ''));
  } catch {
    ok = false;
  }
  if (!ok) refuse('its signature is wrong');
  if (expectId && id !== expectId) throw new ServerError('The server at this address isn’t the one you joined. Kea didn’t connect. If the organization moved its server, remove it here and join again with a new link.', 495, { identity: false, changed: true });
  return { serverId: id, name: String(a.name || '').slice(0, 120) || null, publicKey: { kty: 'OKP', crv: 'Ed25519', x: jwk.x } };
}

/**
 * The list of joined servers and their secrets, for one computer.
 *   file:        servers.json (no secrets): { servers: [{ account, url, serverId, name, joinedAt, signedOut? }] }
 *   secretsFile: the passes and server sessions, sealed (seal/unseal: Electron's safeStorage)
 *   account:     { key() -> this Kea account's id here or null, req(method, path, body, opts) -> the account server }
 *   fetchFn:     fetch (timedFetch from accountCore wraps it with a time limit)
 */
function createServers({ file, secretsFile, seal = (s) => Buffer.from(s), unseal = (b) => b.toString('utf8'), fetchFn, timedFetch, account, now = () => Date.now(), onChange = () => {} }) {
  const readList = () => {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(j.servers) ? j.servers : [];
    } catch {
      return [];
    }
  };
  const writeList = (list) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ servers: list }, null, 1));
  };
  const readSecrets = () => {
    try {
      return JSON.parse(unseal(fs.readFileSync(secretsFile)));
    } catch {
      return {};
    }
  };
  const writeSecrets = (s) => {
    fs.mkdirSync(path.dirname(secretsFile), { recursive: true });
    fs.writeFileSync(secretsFile, seal(JSON.stringify(s)));
  };
  const skey = (acct, id) => `${acct}|${id}`;
  const me = () => {
    const k = account.key();
    if (!k) throw new ServerError('Sign in with Google to use this.', 401, { needsAccount: true });
    return k;
  };
  const mine = () => {
    const k = account.key();
    return k ? readList().filter((s) => s.account === k) : [];
  };
  const find = (id) => mine().find((s) => s.serverId === id) ?? null;
  const update = (id, patch) => {
    const k = me();
    const list = readList();
    const i = list.findIndex((s) => s.account === k && s.serverId === id);
    if (i < 0) return null;
    list[i] = { ...list[i], ...patch };
    for (const [key, v] of Object.entries(patch)) if (v === undefined) delete list[i][key];
    writeList(list);
    onChange();
    return list[i];
  };
  const secretOf = (id) => readSecrets()[skey(me(), id)] ?? {};
  const setSecret = (id, patch) => {
    const all = readSecrets();
    const k = skey(me(), id);
    all[k] = { ...(all[k] || {}), ...patch };
    writeSecrets(all);
  };

  /** One request to a server; not reaching it is status 0. Returns the parsed JSON (or throws ServerError). */
  async function raw(url, method, p, body, token) {
    let res;
    try {
      res = await timedFetch(fetchFn, url + p, {
        method,
        headers: { 'content-type': 'application/json', 'x-kea': '1', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }, LIMITS.req);
    } catch {
      throw new ServerError('Can’t reach this organization’s server right now. Kea tries again by itself.', 0, { unreachable: true });
    }
    let data = {};
    try {
      data = res.json();
    } catch {}
    if (!data || typeof data !== 'object') data = {};
    if (!res.ok) throw new ServerError(data.error || `The server said ${res.status}.`, res.status, data);
    return data;
  }

  async function identity(url, expectId) {
    const nonce = crypto.randomBytes(16).toString('hex');
    return checkIdentity(await raw(url, 'GET', `/v1/identity?nonce=${nonce}`), nonce, expectId);
  }

  /** A pass for this server: a new one from the account server, or (while it can't be reached) the one Kea has. */
  async function pass(id, { fresh = false } = {}) {
    const s = secretOf(id);
    const have = s.pass && s.passExp > now() + 60_000 ? s : null;
    if (have && !fresh && now() - (s.passAt || 0) < PASS_RENEW_MS) return have.pass;
    let r;
    try {
      r = await account.req('POST', '/v1/pass', { serverId: id });
    } catch (e) {
      // The account server is down or offline: keep going on the pass Kea has (protocol 2.7).
      if (e.status === 0 && have) return have.pass;
      if (e.status === 404 || e.status === 405) throw new ServerError('Your Kea account server can’t sign you in to other servers yet. It needs an update.', 501, { noPasses: true });
      throw e;
    }
    const p = passPayload(r.pass);
    // (Only a pass made for this server is ever handed to it.)
    if (!p || p.aud !== `keas:${id}`) throw new ServerError('The Kea account server sent a pass for another server. Kea didn’t use it.', 502);
    const exp = asMs(r.exp ?? p.exp);
    setSecret(id, { pass: r.pass, passExp: exp, passAt: now() });
    return r.pass;
  }

  /** Signs in to a server with a pass: checks who it is first, then trades the pass for the server's session. */
  async function signIn(entry, { fresh = false } = {}) {
    await identity(entry.url, entry.serverId);
    const p = await pass(entry.serverId, { fresh });
    let r;
    try {
      r = await raw(entry.url, 'POST', '/v1/auth/pass', { pass: p });
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        // A pass the server won't take: try once with a brand-new one (an older pass may have been replaced); a
        // server that refuses that too has signed this account out.
        // (Also when no newer pass can be had: the account server is down, or it won't give one any more.)
        if (!fresh) {
          try {
            return await signIn(entry, { fresh: true });
          } catch (e2) {
            if (e2.data?.signedOut || e2.status === 495) throw e2;
          }
        }
        markSignedOut(entry.serverId, e.message);
        throw signedOutError(entry, e);
      }
      throw e;
    }
    const token = r.token || r.session;
    if (!token) throw new ServerError('The server didn’t start a session.', 502);
    setSecret(entry.serverId, { token, tokenAt: now() });
    if (find(entry.serverId)?.signedOut) update(entry.serverId, { signedOut: undefined, signedOutAt: undefined, message: undefined });
    return token;
  }
  const signedOutError = (entry, e) => new ServerError(`${entry.name || 'This organization'} signed you out.`, 401, { signedOut: true, serverId: entry.serverId, reason: e?.message || null });
  function markSignedOut(id, reason) {
    update(id, { signedOut: true, signedOutAt: now(), message: reason || null });
    setSecret(id, { token: null });
  }

  /** A request to a joined server, with its session (signing in with a pass when there's none or it ended). */
  async function req(id, method, p, body) {
    const entry = find(id);
    if (!entry) throw new ServerError('This server isn’t one of yours on this computer.', 404);
    if (entry.signedOut) throw signedOutError(entry);
    let token = secretOf(id).token;
    if (!token) token = await signIn(entry);
    try {
      return await raw(entry.url, method, p, body, token);
    } catch (e) {
      if (e.status !== 401) throw e;
      // The server session ended: a new one from the pass (signIn marks the account signed out if that's refused).
      token = await signIn(entry);
      return raw(entry.url, method, p, body, token);
    }
  }

  /**
   * Joining by link (or address + code): the server proves who it is, a pass gets a session, and the code goes to
   * the server. The server is added to the list only once it took the code.
   */
  async function join(input) {
    const { url, code } = parseJoin(input);
    if (!url) throw new ServerError('That code doesn’t say which server it’s for. Use the join link, or enter the server’s address under Advanced.', 400, { needsServer: true });
    const acct = me();
    const known = mine().find((s) => s.url === url);
    const id = await identity(url, known?.serverId ?? null);
    const entry = known ?? { account: acct, url, serverId: id.serverId, name: id.name, joinedAt: now() };
    if (!known) {
      // (Added first, so the pass and session can be stored for it; taken out again if the code doesn't work.)
      writeList([...readList(), entry]);
    } else if (known.signedOut) update(id.serverId, { signedOut: undefined, signedOutAt: undefined, message: undefined });
    try {
      const token = await signIn(entry, { fresh: !!known?.signedOut });
      const r = await raw(url, 'POST', '/v1/orgs/join', { code }, token);
      if (id.name && id.name !== entry.name) update(entry.serverId, { name: id.name });
      onChange();
      return { ...r, server: view(find(entry.serverId)) };
    } catch (e) {
      if (!known) remove(entry.serverId);
      throw e;
    }
  }

  /** Renews passes (and so server sessions) that are a day old. Quiet: nothing is shown for an offline server. */
  async function renew() {
    const out = [];
    for (const s of mine()) {
      if (s.signedOut) continue;
      const sec = secretOf(s.serverId);
      if (sec.passAt && now() - sec.passAt < PASS_RENEW_MS && sec.token) continue;
      try {
        await signIn(s);
        out.push({ serverId: s.serverId, ok: true });
      } catch (e) {
        out.push({ serverId: s.serverId, ok: false, status: e.status, error: e.message });
      }
    }
    return out;
  }

  function remove(id) {
    const k = account.key();
    writeList(readList().filter((s) => !(s.account === k && s.serverId === id)));
    const all = readSecrets();
    delete all[skey(k, id)];
    writeSecrets(all);
    onChange();
  }

  const view = (s) =>
    s && {
      serverId: s.serverId,
      url: s.url,
      name: s.name,
      joinedAt: s.joinedAt,
      signedOut: !!s.signedOut,
      message: s.signedOut ? `${s.name || 'This organization'} signed you out.` : null,
      passUntil: (() => {
        try {
          return secretOf(s.serverId).passExp ?? null;
        } catch {
          return null;
        }
      })(),
    };
  const list = () => mine().map(view);

  /** "Sign in again" after a server signed this account out: a new pass, and the server decides. */
  async function again(id) {
    const entry = find(id);
    if (!entry) throw new ServerError('This server isn’t one of yours on this computer.', 404);
    update(id, { signedOut: undefined, signedOutAt: undefined, message: undefined });
    await signIn({ ...entry, signedOut: false }, { fresh: true });
    return view(find(id));
  }

  /** This server's session, signing in with a pass when there's none (for the files sync). */
  async function session(id) {
    const entry = find(id);
    if (!entry) throw new ServerError('This server isn’t one of yours on this computer.', 404);
    if (entry.signedOut) throw signedOutError(entry);
    return secretOf(id).token || signIn(entry);
  }

  return { list, join, req, renew, remove, again, session, find, identity, _secretOf: secretOf };
}

module.exports = { createServers, parseJoin, joinLink, cleanUrl, checkIdentity, serverIdOf, passPayload, ServerError, PASS_RENEW_MS, DAY, LIMITS };
