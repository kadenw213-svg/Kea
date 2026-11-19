// Real sources only (electron/sources.cjs): what the registries confirm is shown; anything else never is.
// The registries are faked here (no network): Crossref, Open Library and the links' own answers.
// Run: node --test test/sources/sources.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../worker/electronStub.cjs');
const sources = require('../../electron/sources.cjs');

const real = globalThis.fetch;
after(() => (globalThis.fetch = real));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const crossref = (doi, title = 'Sleep and memory', authors = [{ given: 'Ana', family: 'Reyes' }]) => ({ DOI: doi, title: [title], author: authors, issued: { 'date-parts': [[2021]] }, 'container-title': ['Journal of Study'], publisher: 'Academic Press', type: 'journal-article' });
const gone = new Set(['https://doi.org/10.1000/gone']);

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.crossref.org/works?')) return json({ message: { items: [crossref('10.1000/good'), crossref('10.1000/gone', 'A vanished paper'), crossref('10.1000/anon', 'No author', []), crossref('10.1000/blocked', 'Behind a wall')] } });
  if (u.startsWith('https://api.crossref.org/works/10.1000%2Freal')) return json({ message: crossref('10.1000/real') });
  if (u.startsWith('https://api.crossref.org/works/')) return json({ status: 'error' }, 404);
  if (u.startsWith('https://openlibrary.org/search.json')) return json({ docs: [{ title: 'Why We Sleep', author_name: ['Matthew Walker'], first_publish_year: 2017, publisher: ['Scribner'], isbn: ['9781501144318'], key: '/works/OL1W' }, { title: 'No ISBN book', author_name: ['X'], key: '/works/OL2W' }] });
  if (u.startsWith('https://openlibrary.org/api/books?bibkeys=ISBN:9781501144318')) return json({ 'ISBN:9781501144318': { title: 'Why We Sleep', authors: [{ name: 'Matthew Walker' }], publishers: [{ name: 'Scribner' }], publish_date: '2017', url: 'https://openlibrary.org/books/OL1M' } });
  if (u.startsWith('https://openlibrary.org/api/books')) return json({});
  if (u.startsWith('https://doi.org/') || u.startsWith('https://openlibrary.org/works')) {
    if (gone.has(u)) return new Response('', { status: 404 });
    if (u.includes('blocked')) return new Response('', { status: 403 });
    return new Response('', { status: 200 });
  }
  throw new Error(`unexpected request: ${u}`);
};

test('search keeps only records a registry confirms, with an author, and drops dead links', async () => {
  const found = await sources.search('sleep and memory');
  const titles = found.map((s) => s.title);
  assert.ok(titles.includes('Sleep and memory'));
  assert.ok(!titles.includes('A vanished paper'), 'a link that leads nowhere is dropped');
  assert.ok(!titles.includes('No author'), 'a record with no author is not a source to cite');
  assert.ok(!titles.includes('No ISBN book'));
  assert.ok(titles.includes('Why We Sleep'));
  const good = found.find((s) => s.title === 'Sleep and memory');
  assert.deepEqual([good.doi, good.url, good.verifiedBy, good.linkChecked], ['10.1000/good', 'https://doi.org/10.1000/good', 'Crossref', true]);
});

test('a source behind a login (403) is still real: kept, with its link marked as not checked', async () => {
  const found = await sources.search('sleep and memory');
  const blocked = found.find((s) => s.title === 'Behind a wall');
  assert.ok(blocked);
  assert.equal(blocked.linkChecked, false);
});

test('verify confirms a real DOI and an ISBN, and says nothing for a made-up one', async () => {
  assert.equal((await sources.verify('doi:10.1000/real')).title, 'Sleep and memory');
  assert.equal((await sources.verify('https://doi.org/10.1000/real.')).doi, '10.1000/real');
  assert.equal((await sources.verify('10.9999/invented-by-a-guess')), null);
  assert.equal((await sources.verify('ISBN 978-1-5011-4431-8')).title, 'Why We Sleep');
  assert.equal(await sources.verify('978-0-0000-0000-0'), null);
  assert.equal(await sources.verify('not a source'), null);
});

test('a question that says nothing is refused', async () => {
  await assert.rejects(() => sources.search('  '), /what the source should be about/);
});
