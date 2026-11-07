// Every IPC handler Kea registers answers only Kea's own page (electron/ipcGuard.cjs), and the slideshow's audience
// window gets a strict policy whatever HTML it's sent (electron/present.cjs).
// Run: node --test test/worker/ipcGuard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
require('./electronStub.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const electronDir = path.resolve(here, '../../electron');
const { handleApp, fromApp } = require('../../electron/ipcGuard.cjs');

function sources(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'vendor') sources(f, out);
    } else if (f.endsWith('.cjs') && !f.endsWith('ipcGuard.cjs')) out.push(f);
  }
  return out;
}

test('no IPC handler is registered without the guard', () => {
  const bare = [];
  for (const f of sources(electronDir)) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((l, i) => {
      if (l.includes('ipcMain.handle(') && !/ipcMain\.handle\([^,]+,\s*(require\([^)]*\)\.)?appOnly\(/.test(l)) bare.push(`${path.relative(electronDir, f)}:${i + 1}`);
    });
  }
  assert.deepEqual(bare, [], 'use handleApp(ipcMain, name, fn) or appOnly');
});

test('a guarded handler answers Kea’s own page only', async () => {
  const got = {};
  handleApp({ handle: (n, fn) => (got[n] = fn) }, 'x:y', (_e, a) => a * 2);
  assert.equal(await got['x:y']({ senderFrame: { url: 'app://kea/index.html', parent: null } }, 21), 42);
  for (const e of [{}, { senderFrame: { url: 'https://evil.example/', parent: null } }, { senderFrame: { url: 'app://kea/index.html', parent: {} } }, { senderFrame: { url: 'file:///C:/x.html', parent: null } }]) {
    assert.equal(fromApp(e), false);
    assert.throws(() => got['x:y'](e, 1), /Not allowed/);
  }
});

test('the audience window’s page always starts with a strict policy: no scripts, nothing from outside', () => {
  const { withCsp, AUDIENCE_CSP } = require('../../electron/present.cjs');
  assert.match(AUDIENCE_CSP, /default-src 'none'/);
  assert.match(AUDIENCE_CSP, /script-src 'none'/);
  assert.doesNotMatch(AUDIENCE_CSP, /unsafe-eval|https?:|\*/);
  const meta = `<meta http-equiv="Content-Security-Policy" content="${AUDIENCE_CSP}">`;
  assert.equal(withCsp('<!doctype html><html><head><title>x</title></head><body></body></html>'), `<!doctype html><html><head>${meta}<title>x</title></head><body></body></html>`);
  assert.equal(withCsp('<html lang="en"><body><img src="https://evil.example/x"></body></html>'), `<html lang="en"><head>${meta}</head><body><img src="https://evil.example/x"></body></html>`);
  assert.equal(withCsp('<div>slides</div>'), `<head>${meta}</head><div>slides</div>`);
  assert.equal(withCsp('<!DOCTYPE html><body></body>'), `<!DOCTYPE html><head>${meta}</head><body></body>`);
});
