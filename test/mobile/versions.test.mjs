// The phone never falls behind without saying so (mobile/src/update.ts behind, hub.ts, orgCore.ts): a server that
// turns it away as too old (426) is said with the server's words and an Update button, a newer Kea that the PC is on
// (kea-data.json keaVersion) or a server knows of (/v1/health latest.kea) is said too, and older servers and PCs that
// say nothing change nothing (docs/protocol.md section 0).
//   node --test test/mobile/versions.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../../mobile/src');
const storage = new Map();
globalThis.localStorage = { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => void storage.set(k, String(v)), removeItem: (k) => void storage.delete(k), clear: () => storage.clear() };
// The native side: hubRequest answers what `answer` says.
let answer = () => ({ status: 200, body: '{}' });
globalThis.__keaMock = {
  hubRequest: async (o) => answer(o),
  hubState: async () => ({ url: 'https://keac.example', signedIn: true, email: 'a@x.org', root: '' }),
  appInfo: async () => ({ version: '0.84.1' }),
  addListener: async () => ({ remove() {} })
};
let M;
before(async () => {
  const entry = path.join(os.tmpdir(), `kea-phone-versions-entry-${process.pid}.ts`);
  fs.writeFileSync(entry, `export * from ${JSON.stringify(path.join(src, 'update.ts'))};\nexport { hubCall, hubProblem } from ${JSON.stringify(path.join(src, 'hub.ts'))};\nexport { createOrgClient } from ${JSON.stringify(path.join(src, 'orgCore.ts'))};\n`);
  const out = entry.replace(/\.ts$/, '.cjs');
  const stub = { name: 'kea-stub', setup: (b) => b.onResolve({ filter: /^\.\/kea$/ }, () => ({ path: path.join(here, 'keaStub.mjs') })) };
  await require('esbuild').build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent', plugins: [stub] });
  M = require(out);
  fs.rmSync(out, { force: true });
  fs.rmSync(entry, { force: true });
});

test('the PC or a server on a newer Kea: the phone says it is behind; the same or older version, or nothing said, changes nothing', () => {
  M.noteOwnVersion('0.84.1');
  assert.equal(M.behind(), null);
  M.noteAdvertised('pc', undefined);
  M.noteAdvertised('pc', '0.84.1');
  M.noteAdvertised('account', 'not a version');
  assert.equal(M.behind(), null);
  M.noteAdvertised('pc', '0.85.0');
  assert.deepEqual(M.behind(), { kind: 'behind', version: '0.85.0', from: 'pc', text: 'Your PC has Kea 0.85.0; this phone has 0.84.1.' });
  M.noteAdvertised('account', 'v0.85.2');
  assert.equal(M.behind().text, 'Your Kea account server says Kea 0.85.2 is out; this phone has 0.84.1.');
  // Updated: nothing to say.
  M.noteOwnVersion('0.85.2');
  assert.equal(M.behind(), null);
  M.noteOwnVersion('0.84.1');
});

test('the account server’s 426: plain words, kept (also after a restart) until it serves the phone again; its health’s newest Kea is noted', async () => {
  answer = (o) => (o.path === '/v1/health' ? { status: 200, body: JSON.stringify({ ok: true, service: 'keac', protocol: 1, latest: { kea: '0.86.0' } }) } : { status: 426, body: JSON.stringify({ error: 'Update Kea to keep using your Kea account.', upgradeRequired: true, app: 'keaPhone', minVersion: '0.85.0', updateUrl: 'https://example.org/r' }) });
  await M.hubCall('GET', '/v1/health', undefined, { auth: false });
  assert.equal(M.behind().version, '0.86.0');
  await assert.rejects(M.hubCall('GET', '/v1/me'), (e) => e.status === 426 && e.message === 'Update Kea to keep using your Kea account.' && M.hubProblem(e) === e.message);
  assert.deepEqual(M.behind(), { kind: 'required', text: 'Update Kea to keep using your Kea account.', minVersion: '0.85.0', updateUrl: 'https://example.org/r' });
  assert.match(storage.get('kea.versionNotes'), /Update Kea to keep using your Kea account/, 'kept on the phone');
  answer = () => ({ status: 200, body: '{"account":{}}' });
  await M.hubCall('GET', '/v1/me');
  assert.equal(M.behind().kind, 'behind', 'served again: only "behind" is left');
});

test('an organization’s 426: the organization client says it with the server’s words and the phone offers Update', async () => {
  const seen = [];
  const store = new Map();
  const W = M.createOrgClient({
    native: {
      orgList: async () => ({ servers: [{ serverId: 'S1', url: 'https://pool.example.org', name: 'Pool', hasToken: true, signedOut: false }] }),
      orgRequest: async () => ({ status: 426, body: JSON.stringify({ error: 'Update Kea to keep using this organization’s server.', upgradeRequired: true, minVersion: '0.85.0' }) })
    },
    account: { key: () => 'acct', online: () => true, hosted: async () => false, req: async () => ({}) },
    store: { get: (k) => store.get(k) ?? null, set: (k, v) => store.set(k, v), remove: (k) => store.delete(k) },
    onTooOld: (id, body) => (seen.push([id, body.error]), M.noteTooOld(`org:${id}`, body)),
    onServed: (id) => M.noteServed(`org:${id}`)
  });
  const r = await W._serverReq('S1', 'GET', '/v1/orgs').then(
    () => null,
    (e) => e
  );
  assert.equal(r.status, 426);
  assert.equal(r.message, 'Update Kea to keep using this organization’s server.');
  assert.equal(r.data.upgradeRequired, true);
  assert.deepEqual(seen, [['S1', 'Update Kea to keep using this organization’s server.']]);
  assert.equal(M.behind().kind, 'required');
});
