// Study progress from two devices, merged so nothing done on either is lost. Pure functions over the contents of the
// study folder's progress files, used by Kea on the PC (another computer's or the phone's progress coming in) and by
// Kea on the phone (the PC's copy coming in under what was done on the phone).
//
//   attempts.json   { setId: [{ at, score, total, n, items }] }   every attempt kept
//   cards.json      { setId: { known, at } }                       the newer one
//   stars.json      { key: true }                                  rebuilt from stars-log.json, newest change winning
//   stars-log.json  { key: { on, at } }
//   learn.json      { setId: { cardIndex: level } }                the higher level per card
//   match.json      { setId: ms }                                  the faster time
//   review.json     { key: { box, due, last, lapses, first } }     the one reviewed last

const PROGRESS = ['attempts.json', 'cards.json', 'stars.json', 'stars-log.json', 'learn.json', 'match.json', 'review.json'];

/** Merge `other` into `base` (both { file: contents }), returning the merged files and whether `base` changed. */
function mergeProgress(base, other) {
  const out = {};
  let changed = false;
  const b = (f) => (base[f] && typeof base[f] === 'object' ? base[f] : {});
  const o = (f) => (other[f] && typeof other[f] === 'object' ? other[f] : {});

  const attempts = { ...b('attempts.json') };
  for (const [id, list] of Object.entries(o('attempts.json'))) {
    const have = new Set((attempts[id] || []).map((a) => a.at));
    const add = (Array.isArray(list) ? list : []).filter((a) => a?.at && !have.has(a.at));
    if (add.length) {
      attempts[id] = [...(attempts[id] || []), ...add].sort((x, y) => String(x.at).localeCompare(String(y.at)));
      changed = true;
    }
  }
  out['attempts.json'] = attempts;

  const cards = { ...b('cards.json') };
  for (const [id, c] of Object.entries(o('cards.json')))
    if (c && (!cards[id] || String(c.at || '') > String(cards[id].at || ''))) {
      if (JSON.stringify(c) !== JSON.stringify(cards[id])) changed = true;
      cards[id] = c;
    }
  out['cards.json'] = cards;

  // Stars: a star set before there was a log counts as starred at the start of time, so any logged change wins.
  const log = { ...b('stars-log.json') };
  for (const k of Object.keys(b('stars.json'))) if (!log[k]) log[k] = { on: true, at: '' };
  for (const [k, e] of Object.entries(o('stars-log.json')))
    if (e && String(e.at || '') > String(log[k]?.at || '')) {
      if (!log[k] || log[k].on !== !!e.on) changed = true;
      log[k] = { on: !!e.on, at: e.at };
    }
  for (const k of Object.keys(o('stars.json')))
    if (!log[k]) {
      log[k] = { on: true, at: '' };
      changed = true;
    }
  out['stars-log.json'] = log;
  out['stars.json'] = Object.fromEntries(Object.entries(log).filter(([, e]) => e.on).map(([k]) => [k, true]));

  const learn = { ...b('learn.json') };
  for (const [id, levels] of Object.entries(o('learn.json'))) {
    const cur = { ...(learn[id] || {}) };
    for (const [i, lv] of Object.entries(levels || {}))
      if (!(Number(cur[i]) >= Number(lv))) {
        cur[i] = lv;
        changed = true;
      }
    learn[id] = cur;
  }
  out['learn.json'] = learn;

  const match = { ...b('match.json') };
  for (const [id, ms] of Object.entries(o('match.json')))
    if (Number(ms) > 0 && !(Number(match[id]) <= Number(ms))) {
      match[id] = ms;
      changed = true;
    }
  out['match.json'] = match;

  const review = { ...b('review.json') };
  for (const [k, r] of Object.entries(o('review.json')))
    if (r && String(r.last || '') > String(review[k]?.last || '')) {
      review[k] = r;
      changed = true;
    }
  out['review.json'] = review;

  return { files: out, changed };
}

module.exports = { PROGRESS, mergeProgress };
