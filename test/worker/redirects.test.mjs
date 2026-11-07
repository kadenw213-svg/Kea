// A scan's fetch checks every redirect before following it: the refused address is never contacted (by then the session's
// cookies and the query string would already have reached it). What a scan may follow: an address it may read, a class
// site's file server, the same site. And Kea's own Hub: moving to another Hub's address signs out here first.
// Run: node --test test/worker/redirects.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electron = require('./electronStub.cjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-redirects-test-'));
electron._paths.userData = dir;
electron._paths.appData = dir;
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const { fetchHops, publicHttps } = require('../../electron/scholar/hopFetch.cjs');
const browser = require('../../electron/scholar/browser.cjs');
const mcp = require('../../electron/scholar/mcp.cjs');

/** A stand-in for Electron's net.request: `site[url]` is a redirect's target, or a final answer. */
function fakeNet(site) {
  const contacted = [];
  const net = {
    request: ({ url }) => {
      const req = new EventEmitter();
      let cur = url;
      const go = () => {
        contacted.push(cur);
        const a = site[cur];
        if (typeof a === 'string') {
          const next = a;
          let followed = false;
          req.followRedirect = () => {
            followed = true;
            cur = next;
            setImmediate(go);
          };
          req.emit('redirect', 302, 'GET', next, {});
          if (!followed) req.emit('error', new Error('Redirect was cancelled'));
          return;
        }
        const res = new EventEmitter();
        res.statusCode = a?.status ?? 200;
        res.headers = a?.headers ?? { 'content-type': 'text/plain' };
        req.emit('response', res);
        setImmediate(() => {
          res.emit('data', Buffer.from(a?.body ?? 'ok'));
          res.emit('end');
        });
      };
      req.end = () => setImmediate(go);
      return req;
    }
  };
  return { net, contacted };
}

test('https on a public host is the rule when a caller has none of its own', () => {
  for (const ok of ['https://d2l.school.edu/x', 'https://inst-fs.inscloudgate.net/f']) assert.equal(publicHttps(ok), true, ok);
  for (const bad of ['http://d2l.school.edu/', 'file:///C:/x', 'https://localhost/', 'https://127.0.0.1/', 'https://[::1]/', 'https://169.254.169.254/latest', 'https://10.0.0.5/', 'https://intranet/', 'https://printer.local/', 'nonsense']) assert.equal(publicHttps(bad), false, bad);
});

test('a refused redirect is never contacted, and says where it was going', async () => {
  const { net, contacted } = fakeNet({ 'https://a.school.edu/x': 'https://evil.example/?q=secret' });
  await assert.rejects(fetchHops(net, {}, 'https://a.school.edu/x', (n) => n.includes('school.edu')), (e) => e.refusedHop === 'https://evil.example/?q=secret');
  assert.deepEqual(contacted, ['https://a.school.edu/x']);
});

test('each hop is checked, not just the first, and the answer has the final address', async () => {
  const site = { 'https://a.school.edu/1': 'https://b.school.edu/2', 'https://b.school.edu/2': 'https://c.school.edu/3', 'https://c.school.edu/3': { body: 'done', headers: { 'content-type': 'text/plain', 'set-cookie': ['a=1', 'b=2'] } } };
  const { net } = fakeNet(site);
  const seen = [];
  const res = await fetchHops(net, {}, 'https://a.school.edu/1', (n, from) => (seen.push([n, from]), true));
  assert.deepEqual(seen, [['https://b.school.edu/2', 'https://a.school.edu/1'], ['https://c.school.edu/3', 'https://b.school.edu/2']]);
  assert.equal(res.url, 'https://c.school.edu/3');
  assert.equal(res.status, 200);
  assert.equal(res.ok, true);
  assert.equal(await res.text(), 'done');
  assert.equal(res.headers.get('content-type'), 'text/plain');
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'done');

  const second = fakeNet({ 'https://a.school.edu/1': 'https://b.school.edu/2', 'https://b.school.edu/2': 'https://evil.example/' });
  await assert.rejects(fetchHops(second.net, {}, 'https://a.school.edu/1', (n) => n.includes('school.edu')), /doesn’t read/);
  assert.ok(!second.contacted.includes('https://evil.example/'));
});

test('the first address is checked too, whatever rule the caller passes: never this computer or the home network', async () => {
  for (const bad of ['https://127.0.0.1/', 'https://localhost/x', 'https://10.0.0.5/', 'http://a.school.edu/', 'file:///C:/x']) {
    const { net, contacted } = fakeNet({});
    await assert.rejects(fetchHops(net, {}, bad, () => true), (e) => e.refusedHop === bad, bad);
    assert.deepEqual(contacted, [], bad);
  }
});

test('a redirect loop ends', async () => {
  const { net } = fakeNet({ 'https://a.school.edu/1': 'https://a.school.edu/2', 'https://a.school.edu/2': 'https://a.school.edu/1' });
  await assert.rejects(fetchHops(net, {}, 'https://a.school.edu/1'), /too many/);
});

test('what a scan’s own fetch may be redirected to', () => {
  const schoolInfo = browser.schoolInfo;
  browser.schoolInfo = () => ({ home: 'https://d2l.school.edu/d2l/home', host: 'd2l.school.edu' });
  try {
    const hop = (next, from = 'https://d2l.school.edu/x') => mcp.allowedHop(next, from);
    // The class site, its school, known platforms; Canvas's file servers; the same site ("www.", a trailing slash).
    for (const ok of ['https://d2l.school.edu/y', 'https://cdn.school.edu/y', 'https://www.aleks.com/', 'https://inst-fs-iad-prod.inscloudgate.net/files/1', 'https://x.canvas-user-content.com/1', 'https://instructure-uploads.s3.amazonaws.com/f']) assert.equal(hop(ok), true, ok);
    assert.equal(hop('https://www.article.example/a', 'https://article.example/a'), true);
    // Never anywhere else, however it's spelled, and not back to this computer.
    for (const bad of ['https://evil.example/?q=secret', 'https://evil.example/d2l.school.edu', 'https://d2l.school.edu.evil.example/', 'http://d2l.school.edu/y', 'https://127.0.0.1/', 'https://localhost:4860/', 'file:///C:/Windows/win.ini', 'https://evil.s3.amazonaws.com/f', 'https://evil.inscloudgate.net.evil.example/']) assert.equal(hop(bad), false, bad);
  } finally {
    browser.schoolInfo = schoolInfo;
  }
});

test('moving to another Hub’s address ends the sign-in here; only Kea’s own page may do it', async () => {
  const handlers = {};
  electron.ipcMain.handle = (name, fn) => (handlers[name] = fn);
  // (No network and no background work: what register() starts on timers never runs here.)
  const asked = [];
  const realFetch = electron.net.fetch;
  electron.net.fetch = async (url, opts) => {
    asked.push({ url: String(url), auth: opts?.headers?.authorization || '' });
    throw new Error('offline');
  };
  const timers = { setTimeout: globalThis.setTimeout, setInterval: globalThis.setInterval };
  globalThis.setTimeout = globalThis.setInterval = () => ({ unref() {} });
  const realTimers = () => Object.assign(globalThis, timers);
  try {
    const hub = require('../../electron/hub.cjs');
    hub.register();
    realTimers();
    assert.ok(handlers['hub:setUrl'], 'hub:setUrl registered');
    const appPage = { senderFrame: { url: 'app://kea/index.html', parent: null } };
    const token = path.join(dir, 'hub-session.bin');
    const cache = path.join(dir, 'hub-account.json');
    const signIn = () => {
      fs.writeFileSync(token, 'token-1');
      fs.writeFileSync(cache, JSON.stringify({ email: 'a@b.c' }));
    };
    await handlers['hub:setUrl'](appPage, { url: 'https://one.example' });
    signIn();

    // The same address, or just another spelling of it: still signed in.
    assert.equal((await handlers['hub:setUrl'](appPage, { url: 'https://one.example/' })).ok, true);
    assert.ok(fs.existsSync(token));

    // Any other page, a frame in Kea's page: refused, nothing moves.
    for (const e of [{ senderFrame: { url: 'https://evil.example/', parent: null } }, { senderFrame: { url: 'app://kea/index.html', parent: {} } }, {}])
      assert.throws(() => handlers['hub:setUrl'](e, { url: 'https://evil.example' }), /Not allowed/);
    assert.ok(fs.existsSync(token));

    // A different one: the token and the cached account go before anything can reach it.
    assert.equal((await handlers['hub:setUrl'](appPage, { url: 'https://two.example' })).ok, true);
    assert.ok(!fs.existsSync(token));
    assert.ok(!fs.existsSync(cache));
    assert.deepEqual(asked.filter((a) => a.url.startsWith('https://two.example') && a.auth), []);

    // Back to the address Kea came with counts too.
    signIn();
    assert.equal((await handlers['hub:setUrl'](appPage, { url: '' })).ok, true);
    assert.ok(!fs.existsSync(token));
  } finally {
    realTimers();
    electron.net.fetch = realFetch;
  }
});
