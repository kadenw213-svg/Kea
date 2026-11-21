// Google Contacts for work projects: people simplified and searched by every word.
// Run: node --test test/office/contacts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { _test: C } = require('../../electron/contacts.cjs');
const G = require('../../electron/google.cjs')._drive;

const people = [
  { names: [{ displayName: 'Ana Ruiz' }], emailAddresses: [{ value: 'ana@pool.org' }], phoneNumbers: [{ value: '555-0101' }], organizations: [{ name: 'Westside Pool' }] },
  { names: [{ displayName: 'Ben Ito' }], emailAddresses: [{ value: 'ben@gmail.com' }] },
  { emailAddresses: [] }
].map(C.simplify);

test('a person keeps name, emails, phones and organization', () => {
  assert.deepEqual(people[0], { name: 'Ana Ruiz', emails: ['ana@pool.org'], phones: ['555-0101'], org: 'Westside Pool' });
});

test('search matches every word anywhere; no query lists everyone', () => {
  assert.deepEqual(C.search(people, 'westside ana').map((p) => p.name), ['Ana Ruiz']);
  assert.deepEqual(C.search(people, 'gmail').map((p) => p.name), ['Ben Ito']);
  assert.equal(C.search(people, '').length, 3);
});

test('Google links give their file id', () => {
  assert.equal(G.idFromLink('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit#gid=0'), '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789');
  assert.equal(G.idFromLink('https://example.com/nothing'), null);
});
