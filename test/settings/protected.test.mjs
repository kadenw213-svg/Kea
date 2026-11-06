// The page can't change where Kea's secrets go or what it runs through settings:set (hub.url, the owner key file…),
// and only Kea's own top-level page may call it at all.
//   node --test test/settings/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-settings-'));
const handlers = {};
const electron = {
  app: { getPath: () => dir, isPackaged: true },
  ipcMain: { handle: (ch, fn) => (handlers[ch] = fn), on() {} },
  BrowserWindow: { getAllWindows: () => [] }
};
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electron;
  return load.call(this, request, ...rest);
};
const settings = require('../../electron/settings.cjs');
const { fromApp } = require('../../electron/ipcGuard.cjs');
settings.register();

const frame = (url, parent = null) => ({ senderFrame: { url, parent } });
const app = frame('app://kea/index.html');

test('settings:set from the page: protected keys refused, the rest saved', async () => {
  settings.set({ 'hub.url': 'https://hub.example', 'hub.ownerKeyFile': 'C:\\keys\\owner.key' });
  const warn = console.warn;
  console.warn = () => {};
  try {
    const out = await handlers['settings:set'](app, {
      'hub.url': 'http://evil.example',
      'hub.ownerKeyFile': '\\\\evil\\share\\key',
      'hub.ownerPort': 1,
      'hub.googleClientSecret': 'x',
      'hub.remindMinutes': 15,
      'appearance.theme': 'light',
      'scholar.cloudPath': '\\\\evil\\share',
      'google.clientId': 'javascript:alert(1)'
    });
    assert.equal(out['hub.url'], 'https://hub.example');
    assert.equal(out['hub.ownerKeyFile'], 'C:\\keys\\owner.key');
    assert.equal(out['hub.ownerPort'], undefined);
    assert.equal(out['hub.googleClientSecret'], undefined);
    assert.equal(out['scholar.cloudPath'], undefined);
    assert.equal(out['google.clientId'], undefined);
    // Everyday settings still save, in the same call.
    assert.equal(out['hub.remindMinutes'], 15);
    assert.equal(out['appearance.theme'], 'light');
    // Removing a protected key from the page is refused too.
    const out2 = await handlers['settings:set'](app, { 'hub.url': null });
    assert.equal(out2['hub.url'], 'https://hub.example');
    // A good sync folder and Google client still work.
    const out3 = await handlers['settings:set'](app, { 'scholar.cloudPath': 'D:\\Sync\\Kea', 'google.clientId': '123-abc.apps.googleusercontent.com', 'google.clientSecret': 'GOCSPX-abc_1' });
    assert.equal(out3['scholar.cloudPath'], 'D:\\Sync\\Kea');
    assert.equal(out3['google.clientId'], '123-abc.apps.googleusercontent.com');
  } finally {
    console.warn = warn;
  }
  // Kea's own code (hub:setUrl after its checks) still can.
  assert.equal(settings.set({ 'hub.url': 'https://hub2.example' })['hub.url'], 'https://hub2.example');
});

test('only Kea’s own top-level page may call settings:set', async () => {
  for (const e of [frame('https://evil.example/'), frame('app://kea/index.html', {}), frame('file:///C:/tmp/kea-print.html'), { senderFrame: null }, {}]) {
    assert.equal(fromApp(e), false);
    await assert.rejects(async () => handlers['settings:set'](e, { 'appearance.theme': 'dark' }), /Not allowed/);
  }
  assert.equal(fromApp(app), true);
});
