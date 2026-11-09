// The estimated grade for a document or presentation linked to an assignment: the prompt Claude gets (the rubric
// from the scanned assignment, or its instructions for a rough estimate, and the file's current text), reading its
// answer, the letter grade, and what's cached with the file. Pure (no imports), so tests run it directly.
//
// It is an estimate and a draft, never a promise: Claude's output stays a draft until a person reviews it.

export interface RubricRow {
  criterion: string;
  /** Points the row is worth, when the rubric says. */
  possible: number | null;
  /** What each level asks for, as the rubric words it (short). */
  levels?: string;
}

export interface GradeRow {
  criterion: string;
  earned: number;
  possible: number;
  reason: string;
}

export interface GradeEstimate {
  rows: GradeRow[];
  earned: number;
  possible: number;
  percent: number;
  letter: string;
  /** From the instructions, not a rubric: a rough guess. */
  rough: boolean;
  /** When it was checked (ms), the file's text it was checked against (hash), and the assignment (its signature). */
  at: number;
  docHash: string;
  assignment: string;
  model?: string;
}

/** A guide's rubric (Kea's scan of the class site) as rows: every criterion with its top points and level wording. */
export function rubricRows(guide: { rubric?: { criteria: { name: string; cells: { points: number | null; text: string }[] }[]; levels?: string[] } | null; graded?: { criterion: string; points: number | null; how: string }[] } | null | undefined): RubricRow[] {
  const r = guide?.rubric;
  if (r?.criteria?.length) {
    return r.criteria
      .filter((c) => c.name?.trim())
      .map((c) => {
        const pts = c.cells.map((x) => x.points).filter((x): x is number => typeof x === 'number' && isFinite(x));
        const levels = c.cells
          .map((x, i) => (x.text?.trim() ? `${r.levels?.[i] ? `${r.levels[i]}` : `Level ${i + 1}`}${x.points != null ? ` (${x.points})` : ''}: ${x.text.trim()}` : ''))
          .filter(Boolean)
          .join(' | ');
        return { criterion: c.name.trim(), possible: pts.length ? Math.max(...pts) : null, levels: levels.slice(0, 1200) || undefined };
      });
  }
  // A guide's "how it's graded" list counts as a rubric when it gives points.
  const g = (guide?.graded || []).filter((x) => x.criterion?.trim());
  if (g.length && g.some((x) => typeof x.points === 'number')) return g.map((x) => ({ criterion: x.criterion.trim(), possible: x.points ?? null, levels: x.how?.trim() || undefined }));
  return [];
}

export const GRADE_SYSTEM = `You estimate the grade a student's draft would get, for the student's own information. Grade only against what you are given: the rubric (or, when there is none, the assignment's instructions) and the draft's text. Be honest and specific; don't inflate. Use no tools and don't edit anything. Answer with one JSON object and nothing else.`;

/** The message Claude gets. `mode`: against the rubric, or a rough estimate from the instructions. */
export function buildGradePrompt(p: { title: string; noun: string; mode: 'rubric' | 'instructions'; rows?: RubricRow[]; rubricText?: string; instructions?: string; text: string; maxChars?: number }): string {
  const max = p.maxChars ?? 120_000;
  const text = p.text.length > max ? `${p.text.slice(0, max)}\n[… the rest of the ${p.noun} was cut off here]` : p.text;
  const out: string[] = [`Assignment: ${p.title}`];
  if (p.mode === 'rubric') {
    if (p.rows?.length) {
      out.push(
        'Rubric (grade every row, in this order, with exactly these criterion names and points possible):',
        ...p.rows.map((r, i) => `${i + 1}. ${r.criterion}${r.possible != null ? ` — ${r.possible} points` : ' — points not given (use 10)'}${r.levels ? `\n   Levels: ${r.levels}` : ''}`)
      );
    }
    if (p.rubricText) out.push(`Rubric and guidelines, as given:\n${p.rubricText.slice(0, 40_000)}`);
  } else {
    out.push(
      'There is no rubric. Make a rough estimate from the instructions below: pick 3–6 criteria the instructions clearly ask for, give each the points it seems worth (out of 100 in total), and grade the draft on each.',
      `Instructions:\n${(p.instructions || '(none given)').slice(0, 40_000)}`
    );
  }
  out.push(
    `The student's ${p.noun} as it is now:\n<<<\n${text.trim() || `(The ${p.noun} is empty.)`}\n>>>`,
    'Answer with JSON only, in this shape:\n{"rows":[{"criterion":"…","earned":0,"possible":0,"reason":"one short sentence"}]}\nEach reason is one plain sentence (under 25 words) saying what earned or lost the points. earned is a number from 0 to possible.'
  );
  return out.join('\n\n');
}

/** The JSON object in Claude's answer (bare, or in a ```json block), or null. */
function jsonIn(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const a = c.indexOf('{');
    const b = c.lastIndexOf('}');
    if (a < 0 || b <= a) continue;
    try {
      return JSON.parse(c.slice(a, b + 1));
    } catch {}
  }
  return null;
}

/**
 * Claude's answer as rubric rows, or null when it can't be read. With `rows` (the rubric), the criteria and points
 * possible come from the rubric, never from Claude: only earned points and reasons are taken from the answer.
 */
export function parseGradeAnswer(text: string, rows?: RubricRow[]): GradeRow[] | null {
  const j = jsonIn(String(text || ''));
  const got: any[] = Array.isArray(j?.rows) ? j.rows : Array.isArray(j) ? j : [];
  if (!got.length) return null;
  const num = (v: any) => (typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^\d.\-]/g, '')));
  const clean = (r: any): GradeRow | null => {
    const possible = num(r?.possible);
    const earned = num(r?.earned);
    if (!isFinite(possible) || possible <= 0 || !isFinite(earned)) return null;
    return { criterion: String(r.criterion || '').trim() || 'Criterion', possible, earned: Math.max(0, Math.min(possible, earned)), reason: String(r.reason || '').trim().replace(/\s+/g, ' ').slice(0, 240) };
  };
  if (rows?.length) {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const out: GradeRow[] = [];
    rows.forEach((row, i) => {
      const hit = got.find((g) => norm(String(g?.criterion || '')) === norm(row.criterion)) ?? got[i];
      const possible = row.possible ?? (isFinite(num(hit?.possible)) && num(hit?.possible) > 0 ? num(hit?.possible) : 10);
      const earned = num(hit?.earned);
      if (!hit || !isFinite(earned)) return;
      out.push({ criterion: row.criterion, possible, earned: Math.max(0, Math.min(possible, earned)), reason: String(hit.reason || '').trim().replace(/\s+/g, ' ').slice(0, 240) });
    });
    return out.length === rows.length ? out : null;
  }
  const out = got.map(clean).filter((x): x is GradeRow => !!x);
  return out.length ? out : null;
}

/** The usual US letter for a percentage. */
export function letterGrade(pct: number): string {
  const cut: [number, string][] = [[97, 'A+'], [93, 'A'], [90, 'A-'], [87, 'B+'], [83, 'B'], [80, 'B-'], [77, 'C+'], [73, 'C'], [70, 'C-'], [67, 'D+'], [63, 'D'], [60, 'D-']];
  for (const [min, l] of cut) if (pct >= min) return l;
  return 'F';
}

/** The whole estimate from its rows: points added up (never Claude's own total), the percentage and letter. */
export function totalOf(rows: GradeRow[]): { earned: number; possible: number; percent: number; letter: string } {
  const earned = rows.reduce((n, r) => n + r.earned, 0);
  const possible = rows.reduce((n, r) => n + r.possible, 0);
  const percent = possible > 0 ? Math.round((earned / possible) * 100) : 0;
  return { earned: Math.round(earned * 10) / 10, possible: Math.round(possible * 10) / 10, percent, letter: letterGrade(percent) };
}

/** A short hash of the file's text: the cached estimate knows whether the file changed since it was checked. */
export function textHash(s: string): string {
  let h = 0x811c9dc5;
  const t = s.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + t.length.toString(36);
}

/** What the cache keeps an estimate under: the file and the assignment it was for. */
export const gradeKey = (fileKey: string, assignmentSig: string) => `${fileKey}|${assignmentSig}`;

/** Read a cached estimate, or null when it's missing, damaged, or for another assignment. */
export function readCached(raw: unknown, assignmentSig: string): GradeEstimate | null {
  const g = raw as GradeEstimate | null;
  if (!g || typeof g !== 'object' || !Array.isArray(g.rows) || g.assignment !== assignmentSig || typeof g.at !== 'number') return null;
  return g;
}

/** "just now", "4 min ago", "2 h ago", "yesterday", "5 days ago", or the date. */
export function checkedAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, (now - at) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 2 * 86400) return 'yesterday';
  if (s < 14 * 86400) return `${Math.round(s / 86400)} days ago`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** The estimate made from Claude's answer, or null when the answer can't be read. */
export function makeEstimate(p: { answer: string; rows?: RubricRow[]; rough: boolean; docText: string; assignment: string; at?: number; model?: string }): GradeEstimate | null {
  const rows = parseGradeAnswer(p.answer, p.rough ? undefined : p.rows);
  if (!rows) return null;
  return { rows, ...totalOf(rows), rough: p.rough, at: p.at ?? Date.now(), docHash: textHash(p.docText), assignment: p.assignment, ...(p.model ? { model: p.model } : {}) };
}
