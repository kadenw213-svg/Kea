// Script → footage: find every take of every script line in the raw clips' transcripts, score the takes, pick the best
// one per line, and work out clean cut points that land in the pauses (from the loudness envelope), optionally with
// the long pauses inside a take cut out (jump-cut style). All local and deterministic; Claude reads the result as a
// resource and either takes the automatic rough cut (cut_to_script) or writes its own edit_plan with {line, take}.
import type { MediaItem } from './model';
import type { MediaIndex } from './mediaIndex';
import { envelopeDb, ENV_RATE, tc } from './mediaIndex';

/* ---------- Tokens ---------- */

const FILLERS = new Set(['um', 'uh', 'umm', 'uhh', 'er', 'erm', 'ah', 'hmm', 'mm', 'mhm']);
// Common words count for little when deciding whether a stretch of speech is a take of a line, so "and it ends with a
// finished edit" isn't mistaken for "it starts with a script" on "it / with / a".
const STOP = new Set('a an the and or but so to of in on at for with from by as is are was were be been it its this that these those i im ill ive id you youre we were they he she him her his our your my me us them there here what which who how when then than just do does did not no yes'.split(' '));
const weight = (w: string) => (STOP.has(w) ? 0.3 : 1);
const NUM: Record<string, string> = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' };
export const norm = (w: string) => {
  const t = w.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '');
  return NUM[t] ?? t;
};
const tokens = (text: string) => text.split(/\s+/).map(norm).filter(Boolean);

/** Edit distance ≤ 1 (one insert/delete/substitute) — catches Whisper spelling slips on longer words. */
function near1(a: string, b: string) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
const sim = (a: string, b: string) => (a === b ? 1 : a.length >= 4 && b.length >= 4 && near1(a, b) ? 0.75 : 0);

/* ---------- Script ---------- */

export interface ScriptLine {
  index: number;
  text: string;
  tokens: string[];
  /** Bracketed directions just before this line ("[B-roll: product close-up]"), for the editor. */
  notes: string[];
}

/** Lines to be spoken: one per line of the script, long paragraphs split into sentences; [directions] become notes. */
export function parseScript(script: string): ScriptLine[] {
  const out: ScriptLine[] = [];
  let notes: string[] = [];
  for (const raw of script.replace(/\r/g, '').split('\n')) {
    let line = raw.trim();
    if (!line || /^#/.test(line)) continue;
    // Directions in [brackets] or (parentheses) aren't spoken.
    line = line.replace(/[[(]([^\])]*)[\])]/g, (_m, d) => {
      if (d.trim()) notes.push(d.trim());
      return ' ';
    });
    // "SPEAKER: text" → text
    line = line.replace(/^[A-Z][A-Z .'-]{1,24}:\s+/, '').trim();
    if (!line) continue;
    const sentences = line.length > 160 ? line.match(/[^.!?]+[.!?]+["”’]?|[^.!?]+$/g) || [line] : [line];
    for (const s of sentences) {
      const tk = tokens(s);
      if (!tk.length) continue;
      out.push({ index: out.length, text: s.trim(), tokens: tk, notes });
      notes = [];
    }
  }
  return out;
}

/* ---------- Transcript words (times estimated within each phrase) ---------- */

export interface Word {
  w: string;
  /** As written in the transcript (for captions). */
  raw: string;
  t0: number;
  t1: number;
  filler: boolean;
}

/** Speech islands inside [a, b]: voiced runs, joining gaps shorter than 0.2 s, dropping blips under 80 ms. */
function islands(e: Env, a: number, b: number): [number, number][] {
  const out: [number, number][] = [];
  const f0 = Math.max(0, Math.floor(a * ENV_RATE));
  const f1 = Math.min(e.db.length - 1, Math.ceil(b * ENV_RATE));
  let run = -1;
  for (let f = f0; f <= f1 + 1; f++) {
    const v = f <= f1 && e.db[f] >= e.thr;
    if (v && run < 0) run = f;
    else if (!v && run >= 0) {
      const last = out[out.length - 1];
      const r: [number, number] = [run / ENV_RATE, f / ENV_RATE];
      if (last && r[0] - last[1] < 0.2) last[1] = r[1];
      else out.push(r);
      run = -1;
    }
  }
  return out.filter(([x, y]) => y - x >= 0.08);
}

interface Chunk {
  toks: { raw: string; wt: number }[];
  /** Total spoken weight (letter units). */
  wt: number;
  /** Where Whisper thinks it starts / ends (seconds) — a soft anchor only. */
  a0: number;
  a1: number;
}

/**
 * Global island alignment: match the transcript's punctuation chunks to the speech islands of the whole clip in one
 * monotonic DP. Steps pair 1 chunk with up to 4 islands or up to 4 chunks with 1 island, or skip an island (a breath,
 * cough or music) or a chunk (text with no clear speech). Cost = how far the islands' length is from the words'
 * expected length + a soft pull toward Whisper's own timing (which runs a few tenths late) + a little for merging.
 * Banded around the anchors so hour-long clips stay cheap. Returns [chunk0, chunk1, island0, island1] groups.
 */
function alignChunks(chunks: Chunk[], isl: [number, number][]): [number, number, number, number][] {
  const A = chunks.length;
  const B = isl.length;
  if (!A || !B) return [];
  const voiced = isl.reduce((n, [x, y]) => n + y - x, 0);
  const rate = voiced / chunks.reduce((n, c) => n + c.wt, 0); // seconds per letter unit
  const BAND = 12; // seconds either side of the anchors
  // Island index window per chunk boundary (a = chunks consumed).
  const lo = new Int32Array(A + 1);
  const hi = new Int32Array(A + 1);
  for (let a = 0; a <= A; a++) {
    const t0 = a < A ? chunks[a].a0 : chunks[A - 1].a1;
    let l = 0;
    while (l < B && isl[l][1] < t0 - BAND) l++;
    let h = l;
    while (h < B && isl[h][0] < t0 + BAND) h++;
    lo[a] = a === 0 ? 0 : Math.min(l, lo[a - 1] + B);
    hi[a] = a === A ? B : Math.max(h, a ? hi[a - 1] : 0);
  }
  for (let a = 1; a <= A; a++) lo[a] = Math.max(lo[a], 0), (hi[a] = Math.max(hi[a], hi[a - 1]));
  for (let a = A - 1; a >= 0; a--) lo[a] = Math.min(lo[a], lo[a + 1]);
  const rows: Float64Array[] = [];
  const back: Int32Array[] = []; // island index we came from
  const backA: Int32Array[] = []; // chunk index we came from
  for (let a = 0; a <= A; a++) {
    const w = hi[a] - lo[a] + 1;
    rows.push(new Float64Array(w).fill(Infinity));
    back.push(new Int32Array(w).fill(-1));
    backA.push(new Int32Array(w).fill(-1));
  }
  const get = (a: number, b: number) => (b < lo[a] || b > hi[a] ? Infinity : rows[a][b - lo[a]]);
  const relax = (fa: number, fb: number, a: number, b: number, c: number) => {
    if (b < lo[a] || b > hi[a]) return;
    const k = b - lo[a];
    if (c < rows[a][k]) {
      rows[a][k] = c;
      backA[a][k] = fa;
      back[a][k] = fb;
    }
  };
  const anchorCost = (t: number, isle: number) => 0.35 * Math.min(4, Math.abs(t - isle));
  const durCost = (exp: number, got: number) => Math.abs(exp - got) / Math.max(0.3, exp, got);
  rows[0][0 - lo[0]] = 0;
  for (let a = 0; a <= A; a++)
    for (let b = lo[a]; b <= hi[a]; b++) {
      const c0 = get(a, b);
      if (!Number.isFinite(c0)) continue;
      // skip an island (non-speech sound) / skip a chunk (no clear speech for it)
      if (b < B) relax(a, b, a, b + 1, c0 + 0.5 + 0.4 * Math.min(2, isl[b][1] - isl[b][0]));
      if (a < A) relax(a, b, a + 1, b, c0 + 1.5);
      if (a >= A || b >= B) continue;
      // 1 chunk ↔ m islands
      let got = 0;
      for (let m = 1; m <= 4 && b + m <= B; m++) {
        got += isl[b + m - 1][1] - isl[b + m - 1][0];
        const exp = chunks[a].wt * rate;
        relax(a, b, a + 1, b + m, c0 + durCost(exp, got) + anchorCost(chunks[a].a0, isl[b][0]) + 0.08 * (m - 1));
      }
      // k chunks ↔ 1 island
      let wt = chunks[a].wt;
      for (let k = 2; k <= 4 && a + k <= A; k++) {
        wt += chunks[a + k - 1].wt;
        relax(a, b, a + k, b + 1, c0 + durCost(wt * rate, isl[b][1] - isl[b][0]) + anchorCost(chunks[a].a0, isl[b][0]) + 0.08 * (k - 1));
      }
    }
  if (!Number.isFinite(get(A, B))) return [];
  const groups: [number, number, number, number][] = [];
  let a = A;
  let b = B;
  while (a > 0 || b > 0) {
    const k = b - lo[a];
    const fa = backA[a][k];
    const fb = back[a][k];
    if (fa < 0) return [];
    if (fa < a && fb < b) groups.unshift([fa, a, fb, b]);
    else if (fa < a) groups.unshift([fa, a, -1, -1]); // chunk(s) with no island
    a = fa;
    b = fb;
  }
  return groups;
}

/**
 * Words with estimated times. The transcript's words are cut into punctuation chunks and matched to the clip's
 * speech islands (loudness envelope) by one global alignment; each chunk's words are then spread over the speaking
 * time of its islands. So when Whisper lumps a flubbed take, an "um", a pause and the clean take together, or its own
 * word times run late, every word still lands on the speech that's really there. How long each word takes comes from
 * Whisper's word timing when the model has it (a drawn-out "so…" gets its length), else from its letters.
 */
export function wordsOf(idx: MediaIndex): Word[] {
  const out: Word[] = [];
  const env = envOf(idx);
  const timed = (idx.transcript?.words || []).filter((w) => norm(w.text));
  let ti = 0;
  type Tok = { raw: string; wt: number; t0?: number; t1?: number };
  const take = (raw: string): Tok => {
    const t = timed[ti];
    if (t && norm(t.text) === norm(raw)) {
      ti++;
      return { raw, wt: Math.max(0.08, t.end - t.start) * 15, t0: t.start, t1: t.end };
    }
    return { raw, wt: FILLERS.has(norm(raw)) ? 6 : norm(raw).length + 1.5 };
  };
  const spread = (toks: Tok[], voiced: number[], a: number, b: number) => {
    const total = toks.reduce((n, t) => n + t.wt, 0);
    const at = (frac: number) => {
      if (!voiced.length) return a + frac * Math.max(0.05, b - a);
      const k = Math.min(voiced.length - 1, Math.max(0, frac * voiced.length));
      return voiced[Math.floor(k)] + (k % 1) / ENV_RATE;
    };
    let acc = 0;
    for (const t of toks) {
      const t0 = at(acc / total);
      acc += t.wt;
      const t1 = at(Math.min(1, acc / total) - 1e-6);
      const w = norm(t.raw);
      out.push({ w, raw: t.raw, t0, t1: Math.max(t0 + 0.01, t1 + 1 / ENV_RATE), filler: FILLERS.has(w) });
    }
  };
  const voicedIn = (spans: [number, number][]) => {
    const v: number[] = [];
    if (!env) return v;
    for (const [a, b] of spans) for (let f = Math.max(0, Math.floor(a * ENV_RATE)); f <= Math.min(env.db.length - 1, Math.ceil(b * ENV_RATE)); f++) if (env.db[f] >= env.thr) v.push(f / ENV_RATE);
    return v.length >= 3 ? v : [];
  };
  // Punctuation chunks across the whole transcript, each with an anchor time from Whisper.
  const chunks: Chunk[] = [];
  for (const seg of idx.transcript?.segments || []) {
    const toks = seg.text.split(/\s+/).filter((x) => norm(x)).map(take);
    if (!toks.length) continue;
    const segW = toks.reduce((n, t) => n + t.wt, 0);
    let acc = 0;
    let cur: Tok[] = [];
    const flush = () => {
      if (!cur.length) return;
      const w = cur.reduce((n, t) => n + t.wt, 0);
      const est0 = seg.start + (acc / segW) * (seg.end - seg.start);
      const est1 = seg.start + ((acc + w) / segW) * (seg.end - seg.start);
      chunks.push({ toks: cur, wt: w, a0: cur[0].t0 ?? est0, a1: cur[cur.length - 1].t1 ?? est1 });
      acc += w;
      cur = [];
    };
    toks.forEach((t, i) => {
      const filler = FILLERS.has(norm(t.raw));
      if (filler) flush();
      cur.push(t);
      if ((/[,.;:!?…]["”’)]*$/.test(t.raw) || filler) && i < toks.length - 1) flush();
    });
    flush();
  }
  const isl = env ? islands(env, 0, env.db.length / ENV_RATE) : [];
  const groups = alignChunks(chunks, isl);
  if (!groups.length) {
    // No envelope (or nothing to match): Whisper's timing as it is.
    for (const c of chunks) spread(c.toks, voicedIn([[c.a0, c.a1]]), c.a0, c.a1);
    return out;
  }
  for (const [c0, c1, i0, i1] of groups) {
    const toks = chunks.slice(c0, c1).flatMap((c) => c.toks);
    if (i0 < 0) {
      const a0 = chunks[c0].a0;
      const a1 = chunks[c1 - 1].a1;
      spread(toks, [], a0, a1);
      continue;
    }
    const span = isl.slice(i0, i1);
    spread(toks, voicedIn(span), span[0][0], span[span.length - 1][1]);
  }
  return out;
}

/* ---------- Alignment (Smith-Waterman, many takes per line) ---------- */

export interface Take {
  mediaId: string;
  /** Source seconds of the spoken line (word-estimate). */
  start: number;
  end: number;
  /** Clean cut points, snapped into the pauses. */
  in: number;
  out: number;
  /** What was actually said. */
  said: string;
  /** Script words matched / script words. */
  coverage: number;
  /** Matched / words said (extra words, stumbles and restarts lower it). */
  accuracy: number;
  fillers: number;
  /** Overall quality 0..1. */
  score: number;
  /** Long pauses inside the take [start, end] source seconds (what tighten cuts out). */
  pauses: [number, number][];
}

export interface AlignedLine extends ScriptLine {
  takes: Take[];
  /** Index into takes of the recommended one, or -1 if the line wasn't found. */
  best: number;
}

export interface Alignment {
  lines: AlignedLine[];
  media: { id: string; name: string }[];
  builtAt: number;
}

const MATCH = 2;
const GAP_SAID = -0.8; // extra word said that isn't in the script
const GAP_SCRIPT = -1.2; // script word skipped
const MISMATCH = -1;

/** Best local alignment of `q` (script) in `t` (said), skipping blocked positions. */
function bestLocal(q: string[], t: Word[], blocked: Uint8Array): { score: number; i0: number; i1: number; matched: number; matchedW: number } | null {
  const m = q.length;
  const n = t.length;
  if (!m || !n) return null;
  const W = n + 1;
  const H = new Float32Array((m + 1) * W);
  const B = new Uint8Array((m + 1) * W); // 1 diag, 2 up (skip script), 3 left (extra said word)
  let best = 0;
  let bi = 0;
  let bj = 0;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (blocked[j - 1]) {
        H[i * W + j] = 0;
        continue;
      }
      const tw = t[j - 1];
      const s = sim(q[i - 1], tw.w);
      const diag = H[(i - 1) * W + j - 1] + (s > 0 ? MATCH * s * (0.5 + 0.5 * weight(q[i - 1])) : MISMATCH);
      const up = H[(i - 1) * W + j] + GAP_SCRIPT;
      const left = H[i * W + j - 1] + (tw.filler ? 0 : GAP_SAID);
      let v = 0;
      let b = 0;
      if (diag > v) (v = diag), (b = 1);
      if (up > v) (v = up), (b = 2);
      if (left > v) (v = left), (b = 3);
      H[i * W + j] = v;
      B[i * W + j] = b;
      if (v > best) (best = v), (bi = i), (bj = j);
    }
  }
  if (best <= 0) return null;
  let i = bi;
  let j = bj;
  let matched = 0;
  let matchedW = 0;
  let firstJ = bj;
  while (i > 0 && j > 0 && H[i * W + j] > 0) {
    const b = B[i * W + j];
    if (b === 1) {
      const sv = sim(q[i - 1], t[j - 1].w);
      if (sv > 0) {
        matched += sv === 1 ? 1 : 0.75;
        matchedW += (sv === 1 ? 1 : 0.75) * weight(q[i - 1]);
      }
      firstJ = j;
      i--;
      j--;
    } else if (b === 2) i--;
    else if (b === 3) {
      firstJ = j;
      j--;
    } else break;
  }
  return { score: best, i0: firstJ - 1, i1: bj - 1, matched, matchedW };
}

/* ---------- Cut points from the loudness envelope ---------- */

interface Env {
  db: Float32Array;
  thr: number;
}
function envOf(idx: MediaIndex): Env | null {
  const db = envelopeDb(idx);
  if (!db || db.length < 10) return null;
  const sorted = Float32Array.from(db).sort();
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  const speech = sorted[Math.floor(sorted.length * 0.6)];
  // Quiet = closer to the noise floor than to typical speech.
  return { db, thr: Math.max(floor + 6, Math.min(speech - 6, floor + 18)) };
}
const quietAt = (e: Env, t: number) => {
  const f = Math.round(t * ENV_RATE);
  return f < 0 || f >= e.db.length || e.db[f] < e.thr;
};

/** Quiet runs (≥ minLen s) inside [a, b], in source seconds. */
function quietRuns(e: Env, a: number, b: number, minLen: number): [number, number][] {
  const out: [number, number][] = [];
  let run = -1;
  const f0 = Math.max(0, Math.floor(a * ENV_RATE));
  const f1 = Math.min(e.db.length - 1, Math.ceil(b * ENV_RATE));
  for (let f = f0; f <= f1 + 1; f++) {
    const q = f <= f1 && e.db[f] < e.thr;
    if (q && run < 0) run = f;
    else if (!q && run >= 0) {
      if ((f - run) / ENV_RATE >= minLen) out.push([run / ENV_RATE, f / ENV_RATE]);
      run = -1;
    }
  }
  return out;
}

/** Where to cut in and out of a take: into the nearest pause before the speech starts / after it ends. */
function cutPoints(e: Env | null, start: number, end: number, duration: number, padIn: number, padOut: number): [number, number] {
  if (!e) return [Math.max(0, start - padIn - 0.1), Math.min(duration, end + padOut + 0.1)];
  // Cut in at the speech onset nearest the estimated start (the end of a pause), out at the nearest offset (the start
  // of a pause) — that's where an editor cuts. Without a pause nearby, walk to the edge of the speech.
  const W = 0.6;
  const runs = quietRuns(e, start - W - 0.3, end + W + 0.3, 0.12);
  const nearest = (xs: number[], t: number) => xs.reduce((best, x) => (Math.abs(x - t) < Math.abs(best - t) ? x : best), xs[0]);
  const onsets = runs.map((r) => r[1]).filter((t) => Math.abs(t - start) <= W && t < end - 0.1);
  let a = start;
  if (onsets.length) a = nearest(onsets, start);
  else {
    for (let k = 0; k < 60 && a > 0 && !quietAt(e, a - 0.01); k++) a -= 0.01;
    for (let k = 0; k < 40 && quietAt(e, a) && a < end; k++) a += 0.01;
  }
  const offsets = runs.map((r) => r[0]).filter((t) => Math.abs(t - end) <= W && t > a + 0.2);
  let b = end;
  if (offsets.length) b = nearest(offsets, end);
  else {
    for (let k = 0; k < 60 && b < duration && !quietAt(e, b + 0.01); k++) b += 0.01;
    for (let k = 0; k < 40 && quietAt(e, b) && b > a; k++) b -= 0.01;
  }
  return [Math.max(0, a - padIn), Math.min(duration, b + padOut)];
}

/* ---------- The aligner ---------- */

export function alignScript(script: string, media: { item: MediaItem; idx: MediaIndex }[], opts: { maxTakes?: number; minCoverage?: number; padIn?: number; padOut?: number; maxPause?: number } = {}): Alignment {
  const lines = parseScript(script);
  const maxTakes = opts.maxTakes ?? 8;
  const minCov = opts.minCoverage ?? 0.5;
  const padIn = opts.padIn ?? 0.06;
  const padOut = opts.padOut ?? 0.15;
  const maxPause = opts.maxPause ?? 0.6;
  const said = media.map((m) => ({ ...m, words: wordsOf(m.idx), env: envOf(m.idx) }));
  const aligned: AlignedLine[] = lines.map((l) => ({ ...l, takes: [], best: -1 }));
  for (const L of aligned) {
    for (const m of said) {
      const blocked = new Uint8Array(m.words.length);
      for (let k = 0; k < maxTakes; k++) {
        const r = bestLocal(L.tokens, m.words, blocked);
        if (!r) break;
        const coverage = r.matchedW / L.tokens.reduce((n, w) => n + weight(w), 0);
        if (coverage < minCov) break;
        blocked.fill(1, r.i0, r.i1 + 1);
        const span = m.words.slice(r.i0, r.i1 + 1);
        const spoken = span.filter((w) => !w.filler);
        const fillers = span.length - spoken.length;
        const accuracy = spoken.length ? Math.min(1, r.matched / spoken.length) : 0;
        const start = span[0].t0;
        const end = span[span.length - 1].t1;
        const [cin, cout] = cutPoints(m.env, start, end, m.item.duration, padIn, padOut);
        const pauses = m.env ? quietRuns(m.env, cin + 0.2, cout - 0.2, maxPause) : [];
        L.takes.push({ mediaId: m.item.id, start, end, in: cin, out: cout, said: span.map((w) => w.w).join(' '), coverage: Math.round(coverage * 100) / 100, accuracy: Math.round(accuracy * 100) / 100, fillers, score: 0, pauses });
      }
    }
    // Order takes as recorded (media order, then time), score them; later complete takes win ties (people redo lines
    // until they nail them).
    L.takes.sort((a, b) => (a.mediaId === b.mediaId ? a.start - b.start : media.findIndex((x) => x.item.id === a.mediaId) - media.findIndex((x) => x.item.id === b.mediaId)));
    L.takes.forEach((t, k) => {
      const recency = L.takes.length > 1 ? k / (L.takes.length - 1) : 1;
      t.score = Math.round(Math.max(0, Math.min(1, t.coverage * 0.6 + t.accuracy * 0.3 + recency * 0.1 - t.fillers * 0.04 - t.pauses.length * 0.02)) * 100) / 100;
    });
    let best = -1;
    L.takes.forEach((t, k) => {
      if (best < 0 || t.score > L.takes[best].score + 1e-9 || (Math.abs(t.score - L.takes[best].score) < 1e-9 && k > best)) best = k;
    });
    L.best = best;
  }
  return { lines: aligned, media: media.map((m) => ({ id: m.item.id, name: m.item.name })), builtAt: Date.now() };
}

/** Source segments to play for a take; with tighten, long pauses inside it are cut out (kept short, not removed). */
export function takeSegments(t: Take, tighten: boolean, keepPause = 0.15): { media_id: string; in: number; out: number }[] {
  if (!tighten || !t.pauses.length) return [{ media_id: t.mediaId, in: t.in, out: t.out }];
  const segs: { media_id: string; in: number; out: number }[] = [];
  let a = t.in;
  for (const [p0, p1] of t.pauses) {
    const cut0 = p0 + keepPause / 2;
    const cut1 = p1 - keepPause / 2;
    if (cut1 - cut0 < 0.1) continue;
    if (cut0 - a > 0.15) segs.push({ media_id: t.mediaId, in: a, out: cut0 });
    a = cut1;
  }
  if (t.out - a > 0.15) segs.push({ media_id: t.mediaId, in: a, out: t.out });
  return segs.length ? segs : [{ media_id: t.mediaId, in: t.in, out: t.out }];
}

/**
 * The rough cut: the chosen take of each line, in script order. Consecutive lines that were said in one go (same clip,
 * next line starts right where the last ended) stay one continuous clip so the delivery keeps its natural flow.
 */
export function roughCut(a: Alignment, opts: { overrides?: Record<number, number>; tighten?: boolean } = {}) {
  const picks: { line: number; take: Take }[] = [];
  for (const L of a.lines) {
    const k = opts.overrides?.[L.index] ?? L.best;
    if (k >= 0 && L.takes[k]) picks.push({ line: L.index, take: L.takes[k] });
  }
  const runs: { lines: number[]; take: Take }[] = [];
  for (const p of picks) {
    const last = runs[runs.length - 1];
    if (last && last.take.mediaId === p.take.mediaId && p.take.start >= last.take.end - 0.3 && p.take.start - last.take.end < 0.9) {
      last.lines.push(p.line);
      last.take = { ...last.take, end: p.take.end, out: p.take.out, pauses: [...last.take.pauses, ...p.take.pauses.filter((x) => x[0] > last.take.out)] };
    } else runs.push({ lines: [p.line], take: p.take });
  }
  return runs.map((r) => ({ lines: r.lines, segments: takeSegments(r.take, !!opts.tighten) }));
}

/** Compact view for an agent: per line, the takes with times and scores (not the per-word data). */
export function alignmentSummary(a: Alignment) {
  const name = (id: string) => a.media.find((m) => m.id === id)?.name || id;
  return {
    lines: a.lines.map((L) => ({
      line: L.index,
      text: L.text,
      ...(L.notes.length ? { notes: L.notes } : {}),
      best: L.best,
      takes: L.takes.map((t, k) => ({ take: k, media_id: t.mediaId, clip: name(t.mediaId), in: Math.round(t.in * 100) / 100, out: Math.round(t.out * 100) / 100, at: tc(t.in), score: t.score, coverage: t.coverage, fillers: t.fillers, said: t.said.length > 140 ? t.said.slice(0, 140) + '…' : t.said }))
    })),
    missing: a.lines.filter((L) => L.best < 0).map((L) => L.index)
  };
}

/* ---------- Per-editor store of the latest alignment ---------- */

const store = new WeakMap<object, Alignment>();
export const setAlignment = (key: object, a: Alignment) => store.set(key, a);
export const getAlignment = (key: object) => store.get(key);
