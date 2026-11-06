// The owner console's challenge and response (electron/ownerauth.cjs): the key is never sent, and the answer is the
// same HMAC the Kea Hub (KeaS hub/lib/ownerauth.mjs) checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ownerSign, ownerFetch } = require('../electron/ownerauth.cjs');

test('the signature matches the Hub’s (fixed vector from KeaS hub/lib/ownerauth.mjs)', () => {
  assert.equal(ownerSign('abc123', '0123456789abcdef0123456789abcdef', 'POST', '/owner/scan/next', '{}'),
    '0123456789abcdef0123456789abcdef.0f615e6ca08da51a45476c1ca34472bfe4718bf1f1237d0f99208031a713d9a7');
});

test('ownerFetch gets a nonce first and never sends the key', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/owner/nonce' ? { nonce: 'ab'.repeat(16) } : { ok: true }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const key = 'f'.repeat(64);
  const r = await ownerFetch(base, key, 'POST', '/owner/scan/next', { body: '{}', headers: { 'content-type': 'application/json' } });
  assert.deepEqual(await r.json(), { ok: true });
  srv.close();
  assert.deepEqual(seen.map((s) => s.url), ['/owner/nonce', '/owner/scan/next']);
  assert.equal(seen[1].headers['x-kea-owner-auth'], ownerSign(key, 'ab'.repeat(16), 'POST', '/owner/scan/next', '{}'));
  assert.ok(!JSON.stringify(seen).includes(key), 'the key itself never goes over the wire');
});
