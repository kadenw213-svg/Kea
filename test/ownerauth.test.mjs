// The owner console's challenge and response (electron/ownerauth.cjs): the key is never sent, and the answer is the
// same HMAC the Kea Hub (KeaS hub/lib/ownerauth.mjs) checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ownerSign, ownerReplyMac, ownerFetch, OwnerReplyError } = require('../electron/ownerauth.cjs');

test('the signature matches the Hub’s (fixed vector from KeaS hub/lib/ownerauth.mjs)', () => {
  assert.equal(ownerSign('abc123', '0123456789abcdef0123456789abcdef', 'POST', '/owner/scan/next', '{}'),
    '0123456789abcdef0123456789abcdef.0f615e6ca08da51a45476c1ca34472bfe4718bf1f1237d0f99208031a713d9a7');
});

test('ownerFetch gets a nonce first and never sends the key', async () => {
  const key = 'f'.repeat(64);
  const seen = [];
  const srv = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.setHeader('content-type', 'application/json');
    const out = JSON.stringify(req.url === '/owner/nonce' ? { nonce: 'ab'.repeat(16) } : { ok: true });
    if (req.url !== '/owner/nonce') res.setHeader('x-kea-owner-reply', ownerReplyMac(key, 'ab'.repeat(16), req.headers['x-kea-owner-challenge'], 200, req.method, req.url, out));
    res.end(out);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const r = await ownerFetch(base, key, 'POST', '/owner/scan/next', { body: '{}', headers: { 'content-type': 'application/json' } });
  assert.deepEqual(await r.json(), { ok: true });
  srv.close();
  assert.deepEqual(seen.map((s) => s.url), ['/owner/nonce', '/owner/scan/next']);
  assert.equal(seen[1].headers['x-kea-owner-auth'], ownerSign(key, 'ab'.repeat(16), 'POST', '/owner/scan/next', '{}'));
  assert.ok(!JSON.stringify(seen).includes(key), 'the key itself never goes over the wire');
});

test('an answer that can’t prove it came from the Hub is refused (a program squatting on the port)', async () => {
  const key = 'f'.repeat(64);
  let mode = 'none';
  let lastMac = null;
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/owner/nonce') return res.end(JSON.stringify({ nonce: 'cd'.repeat(16) }));
    const out = JSON.stringify({ job: { id: 'made-up' } });
    if (mode === 'wrongKey') res.setHeader('x-kea-owner-reply', ownerReplyMac('not-the-key', 'cd'.repeat(16), req.headers['x-kea-owner-challenge'], 200, req.method, req.url, out));
    if (mode === 'replay' && lastMac) res.setHeader('x-kea-owner-reply', lastMac);
    if (mode === 'record') {
      lastMac = ownerReplyMac(key, 'cd'.repeat(16), req.headers['x-kea-owner-challenge'], 200, req.method, req.url, out);
      res.setHeader('x-kea-owner-reply', lastMac);
    }
    if (mode === 'refused') {
      res.statusCode = 403;
      return res.end(JSON.stringify({ error: 'no' }));
    }
    res.end(out);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = () => ownerFetch(base, key, 'POST', '/owner/scan/next', { body: '{}' });
  await assert.rejects(call, OwnerReplyError, 'no proof at all');
  mode = 'wrongKey';
  await assert.rejects(call, OwnerReplyError, 'signed with another key');
  mode = 'record';
  assert.deepEqual(await (await call()).json(), { job: { id: 'made-up' } }, 'a real proof is accepted');
  mode = 'replay';
  await assert.rejects(call, OwnerReplyError, 'an old proof can’t be replayed: each call has its own challenge');
  mode = 'refused';
  assert.equal((await call()).status, 403, 'a refusal comes back as a plain failure');
  srv.close();
});
