// Calls to the Kea Hub's owner console (127.0.0.1:4861) without ever sending the owner key: each call first gets a
// single-use nonce (GET /owner/nonce), then sends X-Kea-Owner-Auth: <nonce>.<HMAC-SHA256(key, message)>, where
// message = "kea-owner-v1\n<nonce>\n<METHOD>\n<path and query>\n<sha256 of the body, hex>". A program squatting on the
// port learns nothing it can use. Same scheme as KeaS hub/lib/ownerauth.mjs.
const crypto = require('crypto');

const toBuf = (body) => (body == null ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(String(body), 'utf8'));
function ownerSign(key, nonce, method, path, body) {
  const bodyHash = crypto.createHash('sha256').update(toBuf(body)).digest('hex');
  const msg = `kea-owner-v1\n${nonce}\n${String(method).toUpperCase()}\n${path}\n${bodyHash}`;
  return `${nonce}.${crypto.createHmac('sha256', Buffer.from(String(key).trim(), 'utf8')).update(msg).digest('hex')}`;
}

/** fetch(base + path) to the owner console, signed. `body`: a string or Buffer (sent as is). */
async function ownerFetch(base, key, method, path, { body, headers = {}, fetchFn = fetch } = {}) {
  const nr = await fetchFn(`${base}/owner/nonce`);
  if (!nr.ok) throw new Error(`The owner console didn’t give a challenge (${nr.status}).`);
  const { nonce } = await nr.json();
  const u = new URL(path, base);
  return fetchFn(u.toString(), { method, headers: { ...headers, 'x-kea-owner-auth': ownerSign(key, nonce, method, u.pathname + u.search, body) }, body });
}

module.exports = { ownerSign, ownerFetch };
