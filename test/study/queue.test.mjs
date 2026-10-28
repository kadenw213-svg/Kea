// The Study stream's order (src/lib/studyQueue.ts) and relearn answers in study.cjs. Run: node --test test/study/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createQueue, createLog, historyFrom, firstSentence, pickByMixWith } from '../../src/lib/studyQueue.ts';

const require = createRequire(import.meta.url);
const study = require('../../electron/scholar/study.cjs');
const { mergeProgress } = require('../../electron/scholar/studyMerge.cjs');

/** A seeded random (mulberry32), so every run is the same. */
const seeded = (s = 1) => () => {
  s |= 0;
  s = (s + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const TYPES = ['mc', 'tf', 'blank', 'num'];
const bank = (chapters, per, f = () => ({})) =>
  chapters.flatMap((ch, c) => Array.from({ length: per }, (_, i) => ({ k: `${c}-${i}`, chapter: ch, type: TYPES[(i + c) % TYPES.length], ...f(i, ch) })));

test('a miss comes back 3 to 6 questions later', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const q = createQueue(bank(['Ch 1', 'Ch 2'], 20), { rand: seeded(seed) });
    const missedAt = new Map();
    for (let n = 0; n < 60; n++) {
      const s = q.next();
      if (s.relearn) {
        const d = s.at - missedAt.get(s.item.k);
        assert.ok(d >= 3 && d <= 6, `came back ${d} later (seed ${seed})`);
        missedAt.delete(s.item.k);
        q.answer(s, true);
      } else if (n % 7 === 0) {
        missedAt.set(s.item.k, s.at);
        q.answer(s, false);
      } else q.answer(s, true);
    }
    assert.ok(missedAt.size <= 1, 'every miss but the very last came back');
  }
});

test('the miss gap setting moves when it comes back', () => {
  const q = createQueue(bank(['Ch 1'], 30), { rand: seeded(3), missGap: 8 });
  const first = q.next();
  q.answer(first, false);
  let back = null;
  for (let n = 0; n < 20 && !back; n++) {
    const s = q.next();
    q.answer(s, true);
    if (s.relearn) back = s;
  }
  assert.ok(back && back.at - first.at >= 7 && back.at - first.at <= 10);
});

test('relearn answers do not change lastRight or seen (history and study.cjs)', () => {
  const attempts = {
    'exam-a': [{ at: '2026-10-01T10:00:00.000Z', score: 0, total: 1, n: 1, items: [['abc', false]] }],
    'stream-c1': [{ at: '2026-10-02T10:00:00.000Z', score: 1, total: 1, n: 1, items: [['abc', true, 'r'], ['def', true]] }]
  };
  for (const h of [historyFrom(attempts), study._test.historyFrom(attempts)]) {
    assert.deepEqual(h.abc, { seen: 1, right: 0, last: '2026-10-01T10:00:00.000Z', lastRight: false });
    assert.equal(h.def.lastRight, true);
  }
  // (Older answers, [k, ok], still count.)
  assert.equal(study._test.historyFrom({ x: [{ at: '1', items: [['old', true]] }] }).old.seen, 1);
  // pick() still puts the relearned miss first.
  const h = study._test.historyFrom(attempts);
  const picked = study._test.pick([{ k: 'def', chapter: 'A' }, { k: 'abc', chapter: 'A' }], 1, h);
  assert.equal(picked[0].k, 'abc');
  // And a topic isn't strong on relearn answers alone.
  const four = ['q1', 'q2', 'q3', 'q4'].map((k) => ({ k, section: 'S' }));
  const relearned = study._test.historyFrom({ s: [{ at: '2', items: four.map((x) => [x.k, true, 'r']) }] });
  assert.equal(study._test.strongTopics(four, relearned).size, 0);
});

test('relearn answers survive the merge between devices', () => {
  const pc = { 'attempts.json': { 'stream-c1': [{ at: '2026-10-02T10:00:00.000Z', items: [['abc', true, 'r']] }] } };
  const phone = { 'attempts.json': { 'stream-c1': [{ at: '2026-10-03T10:00:00.000Z', items: [['abc', false]] }] } };
  const { files, changed } = mergeProgress(pc, phone);
  assert.equal(changed, true);
  assert.deepEqual(
    files['attempts.json']['stream-c1'].map((a) => a.items[0]),
    [
      ['abc', true, 'r'],
      ['abc', false]
    ]
  );
  assert.equal(historyFrom(files['attempts.json']).abc.seen, 1);
});

test('a right relearn answer does not make a chapter learned', () => {
  const items = bank(['Ch 1'], 5);
  const q = createQueue(items, { rand: seeded(9), progression: true, chapters: ['Ch 1'], learnedAt: 100 });
  let missed = null;
  let relearned = false;
  // (Until the miss has come back and been answered right: before its next round.)
  for (let n = 0; n < 8 && !relearned; n++) {
    const s = q.next();
    if (s.relearn) (relearned = true), assert.equal(s.item.k, missed);
    if (n === 0) (missed = s.item.k), q.answer(s, false);
    else q.answer(s, true);
  }
  assert.ok(relearned);
  assert.deepEqual(q.learned(), []);
  assert.equal(q.current(), 'Ch 1');
});

test('keeps going after everything is seen, misses first', () => {
  const items = bank(['Ch 1', 'Ch 2'], 6);
  const q = createQueue(items, { rand: seeded(5) });
  const seen = new Set();
  let missed = null;
  for (let n = 0; seen.size < 12; n++) {
    const s = q.next();
    seen.add(s.item.k);
    if (n === 4) (missed = s.item.k), q.answer(s, false);
    else q.answer(s, true);
  }
  const after = [];
  for (let n = 0; n < 200; n++) {
    const s = q.next();
    assert.ok(s);
    after.push(s);
    q.answer(s, true);
  }
  // In the next round of its chapter, the miss (still a miss: its relearn answer doesn't count) comes first.
  const ch = items.find((i) => i.k === missed).chapter;
  assert.equal(after.filter((s) => s.item.chapter === ch && !s.relearn)[0].item.k, missed);
  assert.ok(new Set(after.map((s) => s.item.k)).size === 12);
});

test('takes chapters in turn', () => {
  const q = createQueue(bank(['A', 'B', 'C'], 8), { rand: seeded(2) });
  const chs = [];
  for (let n = 0; n < 9; n++) {
    const s = q.next();
    chs.push(s.item.chapter);
    q.answer(s, true);
  }
  for (let i = 0; i + 2 < chs.length; i += 3) assert.equal(new Set(chs.slice(i, i + 3)).size, 3);
});

test('never the same kind twice in a row when another kind is there', () => {
  for (let seed = 1; seed <= 30; seed++) {
    // Mostly multiple choice in one chapter, a few true-or-false in another, misses coming back.
    const items = [...bank(['A'], 12).map((x) => ({ ...x, type: 'mc' })), ...bank(['B'], 12).map((x) => ({ ...x, k: `b${x.k}`, type: 'tf' }))];
    const q = createQueue(items, { rand: seeded(seed) });
    let prev = null;
    for (let n = 0; n < 40; n++) {
      const s = q.next();
      assert.notEqual(s.item.type, prev, `two ${prev} in a row at ${n} (seed ${seed})`);
      prev = s.item.type;
      q.answer(s, n % 5 !== 0);
    }
  }
  // Only one kind there: it's allowed.
  const one = createQueue(bank(['A'], 3).map((x) => ({ ...x, type: 'mc' })), { rand: seeded(1) });
  for (let n = 0; n < 5; n++) one.answer(one.next(), true);
});

test('the kind mix: weight 0 leaves a kind out, the rest by weight', () => {
  const items = bank(['A'], 40);
  const q = createQueue(items, { rand: seeded(4), mix: { mc: 6, tf: 0, blank: 2, num: 2 } });
  const counts = {};
  for (let n = 0; n < 20; n++) {
    const s = q.next();
    counts[s.item.type] = (counts[s.item.type] || 0) + 1;
    q.answer(s, true);
  }
  assert.equal(counts.tf, undefined);
  assert.ok(counts.mc > counts.blank && counts.mc > counts.num, JSON.stringify(counts));
  assert.deepEqual(pickByMixWith([{ type: 'a' }, { type: 'b' }], 1, { a: 0 }), [{ type: 'b' }]);
});

test('every chapter ticked: curriculum order, recall weighted, no level counts as apply', () => {
  const chapters = ['Ch 1', 'Ch 2', 'Ch 3'];
  // Ch 1 is already known. Each chapter: a fifth recall, the rest apply or with no level (two fifths each).
  const items = bank(chapters, 20, (i) => ({ level: i % 5 === 0 ? 'recall' : i % 2 ? 'apply' : null }));
  const history = Object.fromEntries(items.filter((i) => i.chapter === 'Ch 1').map((i) => [i.k, { seen: 1, right: 1, last: '2026-10-01', lastRight: true }]));
  let recall = 0;
  let noLevel = 0;
  let apply = 0;
  let runs = 0;
  let review = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const q = createQueue(items, { rand: seeded(seed), history, chapters, progression: true, reviewShare: 0.25 });
    assert.equal(q.current(), 'Ch 2', 'a known chapter is skipped');
    const first = [];
    for (let n = 0; n < 12; n++) {
      const s = q.next();
      if (s.item.chapter === 'Ch 1') review++;
      if (s.item.chapter === 'Ch 3') assert.fail('Ch 3 before Ch 2 is learned');
      if (s.item.chapter === 'Ch 2' && first.length < 6) first.push(s.item);
      q.answer(s, true);
    }
    recall += first.filter((i) => i.level === 'recall').length;
    noLevel += first.filter((i) => i.level == null).length;
    apply += first.filter((i) => i.level === 'apply').length;
    runs += first.length;
  }
  // Learned chapters mix in about 1 in 4.
  assert.ok(review / (60 * 12) > 0.12 && review / (60 * 12) < 0.4, `review share ${review / 720}`);
  // Recall is 20% of the chapter: weighted, more of the first questions; but not only recall.
  assert.ok(recall / runs > 0.28 && recall / runs < 0.8, `recall share ${recall / runs}`);
  // No level is treated as apply: about as often as apply (they're 40% each of the chapter).
  assert.ok(Math.abs(noLevel - apply) / runs < 0.15, `no level ${noLevel} vs apply ${apply}`);
});

test('the next chapter joins once this one is learned', () => {
  const chapters = ['Ch 1', 'Ch 2'];
  const items = bank(chapters, 10);
  const q = createQueue(items, { rand: seeded(7), chapters, progression: true, learnedAt: 80 });
  assert.equal(q.current(), 'Ch 1');
  for (let n = 0; n < 8; n++) {
    const s = q.next();
    assert.equal(s.item.chapter, 'Ch 1');
    q.answer(s, true);
  }
  assert.equal(q.current(), 'Ch 2');
  const next = [];
  for (let n = 0; n < 20; n++) {
    const s = q.next();
    next.push(s.item.chapter);
    q.answer(s, true);
  }
  assert.ok(next.filter((c) => c === 'Ch 2').length > next.filter((c) => c === 'Ch 1').length);
});

test('the flush cursor saves each answer exactly once, holding ones being marked', () => {
  const log = createLog();
  const saved = [];
  const a = log.add('a', true, false);
  const b = log.add('b', null, false, true); // a blank being judged
  log.add('c', false, true);
  saved.push(...log.take());
  assert.deepEqual(saved, [['a', true]]);
  saved.push(...log.take());
  assert.equal(saved.length, 1);
  log.mark(b, true);
  log.mark(a, false); // (already saved: no effect)
  saved.push(...log.take());
  assert.deepEqual(saved, [
    ['a', true],
    ['b', true],
    ['c', false, 'r']
  ]);
  const d = log.add('d', null, false, true);
  log.add('e', true, false);
  saved.push(...log.take(true)); // leaving: everything, the unmarked one as null
  log.mark(d, true);
  saved.push(...log.take(true), ...log.take());
  assert.deepEqual(
    saved.map((x) => x[0]),
    ['a', 'b', 'c', 'd', 'e']
  );
  assert.deepEqual(saved[3], ['d', null]);
  assert.equal(log.waiting(), 0);
});

test('first sentence of an explanation', () => {
  assert.deepEqual(firstSentence('Mitosis makes two cells. Each has the same DNA.'), { first: 'Mitosis makes two cells.', rest: 'Each has the same DNA.' });
  assert.equal(firstSentence('Use e.g. the ideal gas law here. Then solve.').first, 'Use e.g. the ideal gas law here.');
  assert.equal(firstSentence('One sentence only.').rest, '');
});
