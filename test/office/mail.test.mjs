// Messages Claude drafted (electron/mail.cjs): addresses, {first}/{name}, and the raw Gmail message.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { _test: m } = require('../../electron/mail.cjs');

test('an address quotes the name and refuses anything that isn’t an email', () => {
  assert.equal(m.address('Ava Brooks', 'ava@example.org'), '"Ava Brooks" <ava@example.org>');
  assert.equal(m.address('', 'ava@example.org'), 'ava@example.org');
  assert.equal(m.address('Eve "x"\r\nBcc: a@b.c', 'eve@example.org'), '"Eve x Bcc: a@b.c" <eve@example.org>');
  assert.throws(() => m.address('X', 'not an email'));
  assert.throws(() => m.address('X', 'a@b.c\r\nBcc: z@z.z'));
});

test('{first} and {name} become each person’s names', () => {
  assert.equal(m.personal('Hi {first}, ({name})', 'Liam Chen'), 'Hi Liam, (Liam Chen)');
  assert.equal(m.personal('Hi {first}', ''), 'Hi there');
});

test('the raw message is base64url with an encoded subject and no header injection', () => {
  const raw = m.rawMessage({ to: '"A" <a@example.org>', subject: 'Availability\r\nBcc: x@y.z', body: 'Line 1\nLine 2' });
  assert.ok(!/[+/=]/.test(raw));
  const text = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.match(text, /^To: "A" <a@example.org>\r\nSubject: =\?UTF-8\?B\?/);
  assert.ok(!/^Bcc:/m.test(text));
  const body = text.split('\r\n\r\n')[1];
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'Line 1\r\nLine 2');
});
