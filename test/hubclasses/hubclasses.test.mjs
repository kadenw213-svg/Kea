// Kea Hub classes in Kea (electron/hubClasses.cjs): reading invite codes and links, Jitsi links, class sessions as
// calendar items, reminders, and Kea study sets turned into Hub sets. The last test sends a converted set and a session
// to a real Kea Hub (KeaS/hub, next to this repo or at KEAS_DIR) to check the Hub accepts what Kea makes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ofetch } from '../ownerFetch.mjs';

const require = createRequire(import.meta.url);
const { _test: hc } = require('../../electron/hubClasses.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.join(process.env.KEAS_DIR || path.resolve(here, '../../../KeaS'), 'hub', 'index.mjs');
const haveHub = fs.existsSync(HUB);

test('invite codes: typed loosely, or inside an invite link', () => {
  assert.equal(hc.parseInvite('ABCDE-FGHJK'), 'ABCDEFGHJK');
  assert.equal(hc.parseInvite('  abcde fghjk '), 'ABCDEFGHJK');
  assert.equal(hc.parseInvite('https://kea.example.ts.net/join/ABCDEFGHJK'), 'ABCDEFGHJK');
  assert.equal(hc.parseInvite('https://kea.example.ts.net/join/abcde-fghjk?x=1'), 'ABCDEFGHJK');
  assert.equal(hc.parseInvite('Join my class: https://kea.example.ts.net/join/ABCDEFGHJK'), 'ABCDEFGHJK');
  assert.equal(hc.parseInvite('kea://join?code=ABCDEFGHJK'), 'ABCDEFGHJK');
  // Not codes: wrong length, characters codes never use (O, 0, 1, I, L), other links.
  assert.equal(hc.parseInvite('ABCDEFGHJ'), null);
  assert.equal(hc.parseInvite('ABCDEFGHJO'), null);
  assert.equal(hc.parseInvite('ABCDEFGH10'), null);
  assert.equal(hc.parseInvite('https://example.com/ABCDEFGHJK'), null);
  assert.equal(hc.parseInvite(''), null);
  assert.equal(hc.inviteLink('https://kea.example.ts.net/', 'ABCDEFGHJK'), 'https://kea.example.ts.net/join/ABCDEFGHJK');
});

test('Jitsi links: the class name plus random letters, always https', () => {
  assert.equal(hc.jitsiLink('BIOL 1010: cells & genes!', 'a1b2c3'), 'https://meet.jit.si/KeaBIOL1010CellsGenesa1b2c3');
  assert.equal(hc.jitsiLink('', 'ff'), 'https://meet.jit.si/KeaClassff');
  const a = hc.jitsiLink('Same class');
  const b = hc.jitsiLink('Same class');
  assert.notEqual(a, b, 'every room is new');
  assert.match(a, /^https:\/\/meet\.jit\.si\/KeaSameClass[0-9a-f]{12}$/);
});

test('class sessions become calendar items on the local date', () => {
  const s = { id: 's1', classId: 'c1', classTitle: 'Biology 101', title: 'Cells', start: new Date(2027, 0, 12, 18, 30).toISOString(), end: new Date(2027, 0, 12, 20, 0).toISOString(), location: null, meetingUrl: 'https://meet.jit.si/KeaBio1', notes: 'Bring the lab sheet' };
  const it = hc.sessionItem(s);
  assert.equal(it.id, 'hub:s1');
  assert.equal(it.courseId, 'hub:c1');
  assert.equal(it.courseCode, 'Biology 101');
  assert.equal(it.type, 'class_session');
  assert.equal(it.date, '2027-01-12');
  assert.equal(it.dateEnd, null);
  assert.equal(it.start, '18:30');
  assert.equal(it.end, '20:00');
  assert.equal(it.location, 'Online');
  assert.equal(it.description, 'Bring the lab sheet');
  assert.deepEqual(it.links, [{ label: 'Join the meeting', url: 'https://meet.jit.si/KeaBio1', kind: 'meeting' }]);
  assert.equal(it.hub.classId, 'c1');
  // Overnight: shows on both days.
  const late = hc.sessionItem({ ...s, start: new Date(2027, 0, 12, 23, 0).toISOString(), end: new Date(2027, 0, 13, 1, 0).toISOString(), location: 'Room 4' });
  assert.equal(late.dateEnd, '2027-01-13');
  assert.equal(late.location, 'Room 4');
  // Between dates, and for one class only.
  const other = { ...s, id: 's2', classId: 'c2', start: new Date(2027, 0, 20, 9).toISOString(), end: new Date(2027, 0, 20, 10).toISOString() };
  assert.deepEqual(hc.itemsBetween([s, other], '2027-01-01', '2027-01-15').map((i) => i.id), ['hub:s1']);
  assert.deepEqual(hc.itemsBetween([s, other], '2027-01-01', '2027-01-31', 'hub:c2').map((i) => i.id), ['hub:s2']);
  assert.deepEqual(hc.itemsBetween([s, other], '2027-01-13', '2027-01-13'), []);
});

test('reminders: once per session time, only inside the window', () => {
  const now = Date.UTC(2027, 0, 12, 18, 0);
  const at = (min) => new Date(now + min * 60_000).toISOString();
  const list = [{ id: 'a', start: at(10) }, { id: 'b', start: at(40) }, { id: 'c', start: at(-5) }];
  assert.deepEqual(hc.dueReminders(list, now, 15, {}).map((s) => s.id), ['a']);
  assert.deepEqual(hc.dueReminders(list, now, 60, {}).map((s) => s.id), ['a', 'b']);
  assert.deepEqual(hc.dueReminders(list, now, 15, { [`a@${at(10)}`]: now }), [], 'already announced');
  assert.deepEqual(hc.dueReminders([{ id: 'a', start: at(12) }], now, 15, { [`a@${at(10)}`]: now }).map((s) => s.id), ['a'], 'moved: announced again');
  assert.deepEqual(hc.dueReminders(list, now, 0, {}), [], 'reminders off');
});

// A predictable "random" for the shuffles.
const seq = (...v) => {
  let i = 0;
  return () => v[i++ % v.length];
};

test('Kea study sets become Hub sets: multiple choice, true/false and flashcards; the rest are counted as left out', () => {
  const r = hc.toHubQuestions({
    questions: [
      { type: 'mc', q: 'Powerhouse of the cell?', choices: ['Nucleus', 'Mitochondrion', 'Ribosome'], answer: 1, explain: 'It makes ATP.' },
      { type: 'tf', q: 'DNA is a protein.', answer: false, explain: '' },
      { type: 'multi', q: 'Pick all', choices: ['a', 'b'], answer: [0, 1], explain: '' },
      { type: 'short', q: 'Explain', answer: 'x', explain: '' },
      { type: 'match', q: 'Match', pairs: [['a', 'b']], explain: '' },
    ],
  });
  assert.equal(r.questions.length, 2);
  assert.equal(r.skipped, 3);
  assert.deepEqual(r.questions[0], { q: 'Powerhouse of the cell?', choices: ['Nucleus', 'Mitochondrion', 'Ribosome'], answer: 1, why: 'It makes ATP.' });
  assert.deepEqual(r.questions[1], { q: 'DNA is a protein.', choices: ['True', 'False'], answer: 1, why: undefined });

  const cards = [
    { front: 'Mitosis', back: 'Cell division into two identical cells' },
    { front: 'Meiosis', back: 'Division making four sex cells' },
    { front: 'Osmosis', back: 'Water moving across a membrane' },
    { front: 'Diffusion', back: 'Particles spreading from high to low' },
    { front: 'Enzyme', back: 'A protein that speeds reactions' },
    { front: 'A picture', back: 'x', image: 'data:...' },
    { front: 'From a question', back: 'Right one', choices: ['Wrong one', 'Right one', 'Another wrong'], explain: 'Because.' },
  ];
  const d = hc.toHubQuestions({ cards }, seq(0.1, 0.5, 0.9, 0.3));
  assert.equal(d.skipped, 1, 'the picture card');
  assert.equal(d.questions.length, 6);
  const plain = cards.filter((c) => !c.image);
  for (const [i, q] of d.questions.entries()) {
    assert.equal(q.q, plain[i].front);
    assert.equal(q.choices[q.answer], plain[i].back, 'the right answer is the back of the card');
    assert.equal(new Set(q.choices).size, q.choices.length, 'no repeated choices');
    assert.ok(q.choices.length >= 2 && q.choices.length <= 8);
  }
  // Ordinary cards get three other backs as wrong answers; a card made from a question keeps its own.
  assert.equal(d.questions[0].choices.length, 4);
  assert.deepEqual([...d.questions[5].choices].sort(), ['Another wrong', 'Right one', 'Wrong one']);
  assert.equal(d.questions[5].why, 'Because.');
  // A single card has nothing to be wrong with.
  assert.deepEqual(hc.toHubQuestions({ cards: [{ front: 'a', back: 'b' }] }), { questions: [], skipped: 1 });
});

let hub, base, ownerPort, dir;
before(async () => {
  if (!haveHub) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kea-hubclasses-'));
  const { createHub } = await import(pathToFileURL(HUB).href);
  hub = createHub({ dataDir: dir, log: false });
  const p = await hub.listen({ port: 0, ownerPort: 0 });
  base = `http://127.0.0.1:${p.port}`;
  ownerPort = p.ownerPort;
});
after(async () => {
  if (hub) await hub.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test('the Hub accepts what Kea makes: an imported set, a Jitsi session, and the invite link', { skip: !haveHub && 'KeaS not found next to this repo (set KEAS_DIR)' }, async () => {
  const call = (method, p, token, body) =>
    fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body && JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const t = (await call('GET', '/v1/terms')).body.terms;
  const reg = await call('POST', '/v1/auth/register', null, { email: 'teach@example.com', password: 'lantern velvet orbit', displayName: 'Tia Teacher', age13: true, termsVersion: t.version, termsSections: t.sections.map((s) => s.id) });
  assert.equal(reg.status, 202);
  const token = (await call('POST', '/v1/auth/login', null, { email: 'teach@example.com', password: 'lantern velvet orbit' })).body.token;
  await ofetch(`http://127.0.0.1:${ownerPort}/owner/accounts/teach@example.com`, { method: 'POST', headers: { 'x-kea-owner-key': hub.ownerKey, 'content-type': 'application/json' }, body: '{"canHost":true}' });
  const cls = (await call('POST', '/v1/classes', token, { title: 'Biology 101' })).body.class;

  const set = hc.toHubQuestions({ questions: [{ type: 'mc', q: 'Q1', choices: ['a', 'b'], answer: 0, explain: 'why' }, { type: 'tf', q: 'Q2', answer: true }], cards: [{ front: 'F1', back: 'B1' }, { front: 'F2', back: 'B2' }] });
  const made = await call('POST', `/v1/classes/${cls.id}/sets`, token, { title: 'Imported', questions: set.questions });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.count, 4);

  const start = new Date(Date.now() + 86400_000);
  const s = await call('POST', `/v1/classes/${cls.id}/sessions`, token, { title: 'Week 1', start: start.toISOString(), end: new Date(start.getTime() + 3600_000).toISOString(), meetingUrl: hc.jitsiLink(cls.title) });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const cal = (await call('GET', '/v1/calendar', token)).body.sessions;
  const items = hc.itemsBetween(cal, '2000-01-01', '2999-12-31');
  assert.equal(items.length, 1);
  assert.equal(items[0].courseCode, 'Biology 101');
  assert.match(items[0].links[0].url, /^https:\/\/meet\.jit\.si\/KeaBiology101/);

  const code = (await call('POST', `/v1/classes/${cls.id}/invites`, token, {})).body.code;
  const page = await fetch(hc.inviteLink(base, code));
  assert.equal(page.status, 200, 'the Hub serves the invite link page');
  assert.equal(hc.parseInvite(hc.inviteLink(base, code)), code);
});
