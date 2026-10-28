// The Study stream's order of questions, on the PC and the phone alike. Pure (no React, no settings, no imports), so
// it can be tested with node:test.
//
// Tick chapters and Start: questions come one after another until the student leaves. Each chapter's questions come
// unseen first, then the ones last missed, then the longest since last seen (as study.cjs's pick() and the old practice
// exam's choose() did), the chapters taking turns, never the same kind of question twice in a row when another kind is
// there, and the kinds in the student's mix (Settings → Practice questions). A miss (or "I don't know") comes back a
// few questions later; answering it then is a relearn answer, saved as [k, ok, 'r'] and not counted towards what's
// learned. When everything has been seen it keeps going round, misses first, with no message and no counter.
//
// Every chapter of a class ticked is the class in curriculum order: one chapter at a time (recall questions weighted
// to come first, but not only them), the next chapter joining once this one is learned (learnedAt% of its questions
// right the last time, relearn answers aside), and learned chapters still coming up about reviewShare of the time.

export interface QueueItem {
  k: string;
  type: string;
  chapter?: string | null;
  level?: string | null;
}
/** How a question has gone (study.cjs history()). */
export interface Hist {
  seen: number;
  right: number;
  last: string;
  lastRight: boolean | null;
}
/** One answer as saved in attempts.json: a relearn answer carries 'r'. */
export type AttemptItem = [string, boolean | null] | [string, boolean | null, 'r'];

/** history() of electron/scholar/study.cjs, over attempts.json's contents: relearn answers count neither way. */
export function historyFrom(attempts: Record<string, { at: string; items?: unknown[][] }[]>): Record<string, Hist> {
  const out: Record<string, Hist> = {};
  for (const list of Object.values(attempts || {}))
    for (const a of Array.isArray(list) ? list : [])
      for (const [k, ok, tag] of (a.items || []) as [string, boolean | null, string?][]) {
        if (ok == null || tag === 'r') continue;
        const h = (out[k] = out[k] || { seen: 0, right: 0, last: '', lastRight: null });
        h.seen++;
        if (ok) h.right++;
        if (String(a.at) >= h.last) (h.last = String(a.at)), (h.lastRight = !!ok);
      }
  return out;
}

/**
 * `n` of `items` (in the order they should be asked first), each kind's share as close to `mix` as the items allow. A
 * kind with too few is made up from the others, in order; a kind weighted 0 is left out unless nothing else is there.
 */
export function pickByMixWith<T extends { type: string }>(items: T[], n: number, mix: Record<string, number>): T[] {
  const allowed = items.filter((i) => (mix[i.type] ?? 1) > 0);
  const pool = allowed.length ? allowed : items;
  const want = Math.min(n, pool.length);
  const byKind = new Map<string, T[]>();
  for (const it of pool) byKind.set(it.type, [...(byKind.get(it.type) || []), it]);
  const kinds = [...byKind.keys()];
  const total = kinds.reduce((t, k) => t + (mix[k] ?? 1), 0) || 1;
  // Whole shares first, then the leftover places to the kinds with the largest remainders.
  const exact = kinds.map((k) => ({ k, x: (want * (mix[k] ?? 1)) / total }));
  const quota = new Map(exact.map(({ k, x }) => [k, Math.min(Math.floor(x), byKind.get(k)!.length)]));
  let left = want - [...quota.values()].reduce((a, b) => a + b, 0);
  for (const { k } of [...exact].sort((a, b) => (b.x % 1) - (a.x % 1))) {
    if (left <= 0) break;
    if (quota.get(k)! < byKind.get(k)!.length) (quota.set(k, quota.get(k)! + 1), left--);
  }
  const chosen = new Set<T>();
  for (const k of kinds) byKind.get(k)!.slice(0, quota.get(k)).forEach((it) => chosen.add(it));
  // (Kinds that ran short: the rest of the places go to whatever comes next.)
  for (const it of pool) {
    if (chosen.size >= want) break;
    chosen.add(it);
  }
  return pool.filter((it) => chosen.has(it));
}

/** The first sentence of an explanation, and the rest (empty when it's one sentence). */
export function firstSentence(text: string): { first: string; rest: string } {
  const t = String(text || '').trim();
  // (A sentence ends at . ! or ? followed by a space and a capital, a digit or an opening bracket; "e.g. " doesn't.)
  const m = /^([\s\S]*?(?<!\b(?:e\.g|i\.e|etc|vs|approx|Fig|Eq|cf))[.!?]["”’)]?)\s+(?=[A-Z0-9(“"$\\])/.exec(t);
  if (!m || m[1].length < 12) return { first: t, rest: '' };
  return { first: m[1], rest: t.slice(m[0].length).trim() };
}

export interface QueueOptions {
  /** Each question's history before this session (relearn answers already left out). */
  history?: Record<string, Hist>;
  /** The chapters in the order to take them (the class's curriculum order). Others follow, as they come. */
  chapters?: string[];
  /** Curriculum progression: one chapter at a time, the next once it's learned (every chapter ticked). */
  progression?: boolean;
  /** Each kind's weight (Settings → Practice questions); 0 leaves it out unless nothing else is there. */
  mix?: Record<string, number>;
  /** A miss comes back this many questions later, give or take one (at least 2). */
  missGap?: number;
  /** Progression: the share of questions from chapters already learned. */
  reviewShare?: number;
  /** Progression: a chapter is learned at this % of its questions right the last time. */
  learnedAt?: number;
  rand?: () => number;
}
export interface Served<T> {
  item: T;
  /** Shown again after a miss: its answer is a relearn answer. */
  relearn: boolean;
  /** Its place in the stream (0 first). */
  at: number;
}

// Progression: how much more often a question of each level comes in the chapter being learned (no level: apply).
const LEVEL_WEIGHT: Record<string, number> = { recall: 3, apply: 1.5, multistep: 1 };
const levelOf = (it: QueueItem) => (it.level && LEVEL_WEIGHT[it.level] ? it.level : 'apply');

export function createQueue<T extends QueueItem>(all: T[], o: QueueOptions = {}) {
  const rand = o.rand || Math.random;
  const mix = o.mix || {};
  const base = o.history || {};
  const missGap = Math.max(2, Math.round(o.missGap ?? 4));
  const reviewShare = Math.max(0, Math.min(1, o.reviewShare ?? 0.25));
  const learnedAt = Math.max(0, Math.min(100, o.learnedAt ?? 80)) / 100;
  const allowed = all.filter((it) => (mix[it.type] ?? 1) > 0);
  const items = allowed.length ? allowed : all;
  const chOf = (it: T) => it.chapter || '';
  const byCh = new Map<string, T[]>();
  for (const ch of o.chapters || []) byCh.set(ch, []);
  for (const it of items) {
    if (!byCh.has(chOf(it))) byCh.set(chOf(it), []);
    byCh.get(chOf(it))!.push(it);
  }
  for (const [ch, list] of byCh) if (!list.length) byCh.delete(ch);
  const order = [...byCh.keys()];
  const typeWeight = new Map<string, number>();
  for (const it of items) typeWeight.set(it.type, Math.max(mix[it.type] ?? 1, allowed.length ? 0 : 1) || 1);
  const weightSum = [...typeWeight.values()].reduce((a, b) => a + b, 0) || 1;

  // This session's answers (not relearn ones): the newest say how a question stands.
  const sess = new Map<string, { lastRight: boolean | null; tick: number }>();
  const cycle = new Map<string, Set<string>>(order.map((ch) => [ch, new Set()]));
  const jitter = new Map<string, number>();
  const pending: { k: string; due: number }[] = [];
  const typeCount = new Map<string, number>();
  const learnedNow = new Set<string>();
  let served = 0;
  let last: T | null = null;
  let turn = 0;
  let reviewTurn = 0;

  const lastRight = (k: string) => (sess.has(k) ? sess.get(k)!.lastRight : (base[k]?.lastRight ?? null));
  const seenEver = (k: string) => sess.has(k) || (base[k]?.seen || 0) > 0;
  /** 0 unseen, 1 last missed, 2 the rest. */
  const tier = (it: T) => (!seenEver(it.k) ? 0 : lastRight(it.k) === false ? 1 : 2);
  /** When last seen (this session's answers newest of all). */
  const when = (k: string) => (sess.has(k) ? 1e15 + sess.get(k)!.tick : Date.parse(base[k]?.last || '') || 0);
  const jit = (k: string) => {
    if (!jitter.has(k)) jitter.set(k, rand());
    return jitter.get(k)!;
  };
  const rank = (a: T, b: T) => tier(a) - tier(b) || (tier(a) ? when(a.k) - when(b.k) : 0) || jit(a.k) - jit(b.k);

  const isLearned = (ch: string) => {
    if (learnedNow.has(ch)) return true;
    const list = byCh.get(ch) || [];
    const ok = list.length > 0 && list.filter((it) => lastRight(it.k) === true).length / list.length >= learnedAt;
    if (ok) learnedNow.add(ch);
    return ok;
  };
  /** Progression: the chapter being learned (the first not yet learned, in order), or null when all are. */
  const current = () => order.find((ch) => !isLearned(ch)) ?? null;
  const isPending = (k: string) => pending.some((p) => p.k === k);

  /** A chapter's questions not yet asked in this round (a new round once all have been). */
  const candidates = (ch: string): T[] => {
    const done = cycle.get(ch)!;
    let list = byCh.get(ch)!.filter((it) => !done.has(it.k) && !isPending(it.k));
    if (!list.length) {
      done.clear();
      for (const it of byCh.get(ch)!) jitter.delete(it.k);
      list = byCh.get(ch)!.filter((it) => !isPending(it.k));
    }
    const fresh = list.filter((it) => it.k !== last?.k);
    return (fresh.length ? fresh : list).sort(rank);
  };

  /** The kind of question the mix wants next, of those given. */
  const wantedType = (types: string[]) => {
    let best = types[0];
    let score = -Infinity;
    for (const t of types) {
      const d = ((typeWeight.get(t) || 1) / weightSum) * (served + 1) - (typeCount.get(t) || 0);
      if (d > score) (score = d), (best = t);
    }
    return best;
  };

  /** The question to ask from a chapter's candidates: the best tier, the kind the mix wants, not the last kind. */
  const choose = (list: T[], weighted: boolean): T | null => {
    if (!list.length) return null;
    const other = list.filter((it) => it.type !== last?.type);
    const pool = other.length ? other : list;
    const top = tier(pool[0]);
    const best = pool.filter((it) => tier(it) === top);
    const type = wantedType([...new Set(best.map((it) => it.type))]);
    const ofType = best.filter((it) => it.type === type);
    if (!weighted) return ofType[0];
    // (Learning a chapter: recall questions more often first, then apply, then multi-step.)
    const total = ofType.reduce((t, it) => t + LEVEL_WEIGHT[levelOf(it)], 0);
    let r = rand() * total;
    for (const it of ofType) if ((r -= LEVEL_WEIGHT[levelOf(it)]) <= 0) return it;
    return ofType[ofType.length - 1];
  };

  /** The chapters to draw from this turn, in the order to try them. */
  const chaptersNow = (): { list: string[]; weighted: boolean } => {
    if (!o.progression) {
      const start = turn++ % order.length;
      return { list: [...order.slice(start), ...order.slice(0, start)], weighted: false };
    }
    const cur = current();
    const learned = order.filter((ch) => ch !== cur && isLearned(ch));
    if (!cur) {
      const start = turn++ % order.length;
      return { list: [...order.slice(start), ...order.slice(0, start)], weighted: false };
    }
    if (learned.length && rand() < reviewShare) {
      const start = reviewTurn++ % learned.length;
      return { list: [...learned.slice(start), ...learned.slice(0, start), cur], weighted: false };
    }
    return { list: [cur, ...learned], weighted: true };
  };

  const take = (it: T, relearn: boolean): Served<T> => {
    if (!relearn) cycle.get(chOf(it))?.add(it.k);
    typeCount.set(it.type, (typeCount.get(it.type) || 0) + 1);
    last = it;
    return { item: it, relearn, at: served++ };
  };

  return {
    /** The next question (null only when there are none at all). */
    next(): Served<T> | null {
      if (!order.length) return null;
      pending.sort((a, b) => a.due - b.due);
      const dueAt = pending.findIndex((p) => p.due <= served && p.k !== last?.k);
      const { list, weighted } = chaptersNow();
      // A miss coming back, unless it's the same kind as the last one and something else can go first (once).
      if (dueAt >= 0) {
        const p = pending[dueAt];
        const it = items.find((x) => x.k === p.k)!;
        const sameKind = it.type === last?.type && p.due >= served;
        const alt = sameKind ? list.flatMap((ch) => candidates(ch)).some((x) => x.type !== last?.type) : false;
        if (!alt) {
          pending.splice(dueAt, 1);
          return take(it, true);
        }
      }
      // The first chapter in turn with something of a different kind; failing that, the first with anything.
      for (const ch of list) {
        const pick = choose(candidates(ch).filter((x) => x.type !== last?.type), weighted && ch === list[0]);
        if (pick) return take(pick, false);
      }
      for (const ch of list) {
        const pick = choose(candidates(ch), weighted && ch === list[0]);
        if (pick) return take(pick, false);
      }
      // (Everything is waiting to come back after a miss: the soonest, now.)
      const p = pending.shift();
      return p ? take(items.find((x) => x.k === p.k)!, true) : null;
    },
    /** How a question went (null: unmarked). A miss comes back in missGap ± 1 questions. */
    answer(s: Served<T>, ok: boolean | null) {
      if (!s.relearn && ok != null) sess.set(s.item.k, { lastRight: ok, tick: s.at });
      if (ok === false && !isPending(s.item.k)) {
        const gap = Math.max(2, missGap + Math.floor(rand() * 3) - 1);
        pending.push({ k: s.item.k, due: s.at + gap });
      }
    },
    /** Progression: the chapter being learned now (null when not in progression, or every chapter is learned). */
    current: () => (o.progression ? current() : null),
    learned: () => order.filter(isLearned)
  };
}

/**
 * The stream's answers waiting to be saved: each saved exactly once, in order, by take(). A written answer still being
 * marked holds back itself and everything after it until it's marked; `final` (leaving) takes everything, an unmarked
 * one as null.
 */
export function createLog() {
  const entries: { k: string; ok: boolean | null; r: boolean; pending: boolean }[] = [];
  let cursor = 0;
  return {
    /** An answer (pending: still being marked). Its index, for mark(). */
    add(k: string, ok: boolean | null, relearn: boolean, pending = false) {
      entries.push({ k, ok, r: relearn, pending });
      return entries.length - 1;
    },
    mark(i: number, ok: boolean | null) {
      const e = entries[i];
      if (e && e.pending) (e.ok = ok), (e.pending = false);
    },
    /** Answers not saved yet. */
    waiting: () => entries.length - cursor,
    /** The answers to save now (each only ever returned once). */
    take(final = false): AttemptItem[] {
      const out: AttemptItem[] = [];
      while (cursor < entries.length && (final || !entries[cursor].pending)) {
        const e = entries[cursor++];
        out.push(e.r ? [e.k, e.pending ? null : e.ok, 'r'] : [e.k, e.pending ? null : e.ok]);
        e.pending = false;
      }
      return out;
    }
  };
}
