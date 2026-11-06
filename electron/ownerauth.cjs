// Calls to the Kea Hub's owner console (127.0.0.1:4861) without ever sending the owner key: each call first gets a
// single-use nonce (GET /owner/nonce), then sends X-Kea-Owner-Auth: <nonce>.<HMAC-SHA256(key, message)>, where
// message = "kea-owner-v1\n<nonce>\n<METHOD>\n<path and query>\n<sha256 of the body, hex>". A program squatting on the
// port learns nothing it can use.
//
// The answer has to prove itself too: it carries X-Kea-Owner-Reply, an HMAC over the nonce, this call's own random
// challenge, the status, method, path and the answer's hash. Without it, a squatter could feed the launcher made-up jobs.
// A refused sign-in (401, 403) comes back unproved, as a failure to act on and nothing more.
// Same scheme as KeaS hub/lib/ownerauth.mjs.
const crypto = require('crypto');

const toBuf = (body) => (body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(String(body), 'utf8'));
const bodyHash = (body) => crypto.createHash('sha256').update(toBuf(body)).digest('hex');
const hmac = (key, msg) => crypto.createHmac('sha256', Buffer.from(String(key).trim(), 'utf8')).update(msg).digest('hex');
function ownerSign(key, nonce, method, path, body) {
  return `${nonce}.${hmac(key, `kea-owner-v1\n${nonce}\n${String(method).toUpperCase()}\n${path}\n${bodyHash(body)}`)}`;
}
const ownerReplyMac = (key, nonce, challenge, status, method, path, body) => hmac(key, `kea-owner-reply-v1\n${nonce}\n${challenge}\n${status}\n${String(method).toUpperCase()}\n${path}\n${bodyHash(body)}`);

class OwnerReplyError extends Error {
  constructor() {
    super('The answer on the owner console’s port didn’t come from your Kea Hub (it couldn’t prove it holds the owner key). Another program may be on that port. Nothing was accepted from it.');
    this.name = 'OwnerReplyError';
  }
}

async function ownerCall(base, key, method, path, { body, headers = {}, fetchFn = fetch } = {}) {
  const nr = await fetchFn(`${base}/owner/nonce`);
  if (!nr.ok) throw new Error(`The owner console didn’t give a challenge (${nr.status}).`);
  const { nonce } = await nr.json();
  const u = new URL(path, base);
  const target = u.pathname + u.search;
  const challenge = crypto.randomBytes(16).toString('hex');
  const r = await fetchFn(u.toString(), { method, headers: { ...headers, 'x-kea-owner-auth': ownerSign(key, nonce, method, target, body), 'x-kea-owner-challenge': challenge }, body });
  const proof = r.headers.get('x-kea-owner-reply');
  if ((r.status === 401 || r.status === 403) && !proof) return r;
  const answer = Buffer.from(await r.arrayBuffer());
  const want = Buffer.from(ownerReplyMac(key, nonce, challenge, r.status, method, target, answer), 'hex');
  const got = Buffer.from(/^[0-9a-f]{64}$/.test(String(proof)) ? proof : '', 'hex');
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new OwnerReplyError();
  // (A Response can't carry a body on these statuses.)
  return new Response([101, 204, 205, 304].includes(r.status) ? null : answer, { status: r.status, headers: r.headers });
}

/** fetch(base + path) to the owner console, signed, with its answer checked. `body`: a string or Buffer (sent as is). */
async function ownerFetch(base, key, method, path, opts = {}) {
  const first = await ownerCall(base, key, method, path, opts);
  // (Flooding the console with challenges can push ours out in the moment before it's used: one more try.)
  if (first.status !== 401) return first;
  const why = await first.clone().json().catch(() => null);
  return /fresh challenge/.test(String(why?.error)) ? ownerCall(base, key, method, path, opts) : first;
}

module.exports = { ownerSign, ownerReplyMac, ownerFetch, OwnerReplyError };
