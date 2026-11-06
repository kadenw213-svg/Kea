// Kea's class-site window (electron/scholar/sitePolicy.cjs): what pages may ask for, where the window may go, and which
// sign-in pages may have a login saved.
//   node --test test/sitepolicy/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../../electron/scholar/sitePolicy.cjs');

const ctx = { home: 'https://learn.colostate.edu/d2l/home', sso: 'login.colostate.edu' };

test('the school’s own domain comes from the Public Suffix List, not the last two labels', () => {
  assert.equal(P.registrableDomain('d2l.ox.ac.uk'), 'ox.ac.uk');
  assert.equal(P.registrableDomain('learn.colostate.edu'), 'colostate.edu');
  assert.equal(P.schoolDomain('d2l.ox.ac.uk'), 'ox.ac.uk');
  // Not all of ac.uk (the old two-label rule trusted every UK university).
  assert.equal(P.inSchoolDomain('evil.ac.uk', 'd2l.ox.ac.uk'), false);
  assert.equal(P.inSchoolDomain('www.cam.ac.uk', 'd2l.ox.ac.uk'), false);
  assert.equal(P.inSchoolDomain('sso.ox.ac.uk', 'd2l.ox.ac.uk'), true);
  // A class site on a platform every school shares is only its own host.
  assert.equal(P.schoolDomain('yourschool.instructure.com'), 'yourschool.instructure.com');
  assert.equal(P.inSchoolDomain('otherschool.instructure.com', 'yourschool.instructure.com'), false);
  assert.equal(P.registrableDomain('127.0.0.1'), '');
});

test('opening another program (openExternal) is never granted, and neither are clipboard-read, fileSystem or idle-detection', () => {
  for (const perm of ['openExternal', 'clipboard-read', 'fileSystem', 'idle-detection', 'geolocation', 'notifications', 'hid', 'usb', 'serial']) {
    for (const url of ['https://learn.colostate.edu/', 'https://www.aleks.com/', 'https://login.colostate.edu/', 'https://app.honorlock.com/']) assert.equal(P.decide(perm, url, ctx), 'deny', `${perm} ${url}`);
  }
});

test('no blanket .edu: another school’s site gets nothing', () => {
  for (const perm of ['fullscreen', 'media', 'display-capture', 'storage-access']) {
    assert.equal(P.decide(perm, 'https://evil.edu/', ctx), 'deny', perm);
    assert.equal(P.decide(perm, 'https://attacker.someschool.edu/', ctx), 'deny', perm);
  }
});

test('camera, microphone and screen: only the class site, its sign-in host and proctoring services, and always asked', () => {
  assert.deepEqual(P.decide('media', 'https://learn.colostate.edu/d2l/x', ctx), { ask: 'media', origin: 'https://learn.colostate.edu' });
  assert.deepEqual(P.decide('display-capture', 'https://learn.colostate.edu/', ctx), { ask: 'screen', origin: 'https://learn.colostate.edu' });
  assert.deepEqual(P.decide('media', 'https://login.colostate.edu/', ctx), { ask: 'media', origin: 'https://login.colostate.edu' });
  for (const h of ['app.honorlock.com', 'getproctorio.com', 'www.respondus.com', 'go.proctoru.com']) assert.equal(typeof P.decide('media', `https://${h}/`, ctx), 'object', h);
  // Not other hosts of the school's domain, not course platforms, not plain http.
  for (const u of ['https://www.colostate.edu/', 'https://www.youtube.com/', 'https://www.aleks.com/', 'http://learn.colostate.edu/', 'file:///C:/x.html', 'not a url']) assert.equal(P.decide('media', u, ctx), 'deny', u);
});

test('school platforms keep what course work needs (full screen, storage), over https only', () => {
  assert.equal(P.decide('fullscreen', 'https://www.aleks.com/', ctx), 'allow');
  assert.equal(P.decide('fullscreen', 'https://www.colostate.edu/', ctx), 'allow');
  assert.equal(P.decide('fullscreen', 'http://www.aleks.com/', ctx), 'deny');
  assert.equal(P.decide('fullscreen', 'https://www.aleks.com.evil.net/', ctx), 'deny');
  assert.equal(P.decide('clipboard-sanitized-write', 'https://anything.example/', ctx), 'allow');
});

test('the window only goes to http(s); mailto is offered after asking; every other scheme is refused', () => {
  for (const u of ['https://learn.colostate.edu/', 'http://example.com/']) assert.equal(P.navigation(u), 'load', u);
  assert.equal(P.navigation('mailto:prof@colostate.edu'), 'confirm');
  for (const u of ['file:///C:/Windows/System32/calc.exe', 'ms-msdt:/id PCWDiagnostic', 'search-ms:query=x', 'javascript:alert(1)', 'zoommtg://zoom.us/join', 'data:text/html,x', '\\\\evil\\share']) assert.equal(P.navigation(u), 'deny', u);
  assert.equal(P.externalAllowed('https://a.example/'), true);
  assert.equal(P.externalAllowed('mailto:a@b.c'), true);
  for (const u of ['http://a.example/', 'ms-settings:', 'file:///C:/', 'vbscript:x']) assert.equal(P.externalAllowed(u), false, u);
});

test('a login is saved only from the class site’s own sign-in or a known sign-in service (the phone’s mayFill rule)', () => {
  const home = 'https://learn.colostate.edu/d2l/home';
  // Before the school's sign-in host is known: the school's domain or a known sign-in service.
  for (const u of ['https://learn.colostate.edu/d2l/login', 'https://login.colostate.edu/idp', 'https://login.microsoftonline.com/x', 'https://accounts.google.com/']) assert.equal(P.mayRememberLogin(u, { home }), true, u);
  // A tenant anyone can make: only when Kea got there from the school's own pages while signing in.
  for (const u of ['https://colostate.okta.com/', 'https://evil.okta.com/login', 'https://evil.onelogin.com/', 'https://evil.duosecurity.com/']) {
    assert.equal(P.mayRememberLogin(u, { home }), false, u);
    assert.equal(P.mayRememberLogin(u, { home, fromHome: true }), true, u);
  }
  // (Not over http, and not any other host because of it; and once the host is known, that decides.)
  assert.equal(P.mayRememberLogin('http://colostate.okta.com/', { home, fromHome: true }), false);
  assert.equal(P.mayRememberLogin('https://www.aleks.com/login', { home, fromHome: true }), false);
  assert.equal(P.mayRememberLogin('https://evil.okta.com/', { home, schoolLoginHost: 'colostate.okta.com', fromHome: true }), false);
  for (const u of ['https://www.aleks.com/login', 'https://evil.edu/login', 'https://colostate.edu.evil.com/', 'http://learn.colostate.edu/d2l/login', 'https://login.microsoftonline.com.evil.net/', 'https://evilokta.com/']) assert.equal(P.mayRememberLogin(u, { home }), false, u);
  // Once known: only that host (and the class site itself).
  const known = { home, schoolLoginHost: 'login.microsoftonline.com' };
  assert.equal(P.mayRememberLogin('https://login.microsoftonline.com/x', known), true);
  assert.equal(P.mayRememberLogin('https://learn.colostate.edu/d2l/login', known), true);
  assert.equal(P.mayRememberLogin('https://login.colostate.edu/', known), false);
  assert.equal(P.mayRememberLogin('https://accounts.google.com/', known), false);
  // No class site set up: nothing.
  assert.equal(P.mayRememberLogin('https://login.microsoftonline.com/', { home: '' }), false);
});
