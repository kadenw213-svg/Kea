// Sign-in clients from the Kea account server (electron/oauthClients.cjs, Kea 0.102.1): a build's own clients win; the
// server's fill in only what the build lacks; and only the fields Kea uses are kept. (Dummy values.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { _test: t, resolveClients } = require('../../electron/oauthClients.cjs');

const server = { google: { desktopClientId: 'server.apps.googleusercontent.com', desktopClientSecret: 'server-secret' }, microsoft: { clientId: 'server-ms' } };

test('the build’s own clients win; the server’s fill in what the build lacks', () => {
  assert.deepEqual(t.effectiveBuild({}, server), server);
  const built = { google: { desktopClientId: 'built.apps.googleusercontent.com', desktopClientSecret: 'built-secret' } };
  const mixed = t.effectiveBuild(built, server);
  assert.equal(mixed.google.desktopClientId, 'built.apps.googleusercontent.com');
  assert.equal(mixed.microsoft.clientId, 'server-ms');
  const c = resolveClients({ env: {}, build: t.effectiveBuild({}, server) });
  assert.deepEqual([c.google.id, c.google.secret, c.google.from, c.microsoft.id], ['server.apps.googleusercontent.com', 'server-secret', 'build', 'server-ms']);
});

test('only the fields Kea uses are kept from the server’s answer', () => {
  assert.deepEqual(t.cleanServerAnswer({ google: { desktopClientId: ' a ', desktopClientSecret: 'b', other: 'x' }, extra: 1 }), { google: { desktopClientId: 'a', desktopClientSecret: 'b' } });
  assert.deepEqual(t.cleanServerAnswer({}), {});
  assert.deepEqual(t.cleanServerAnswer(null), {});
});
