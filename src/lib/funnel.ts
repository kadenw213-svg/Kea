// The model funnel: each message to Claude goes to the size of model it needs. A quick rephrase of a highlighted
// sentence runs on Haiku and comes back in seconds; ordinary edits and questions run on Sonnet; grading against a
// rubric, whole-paper reviews, research, outlines and design work run on the strongest model (the one chosen in
// Settings, Opus 5.5 unless changed). Rules only, no extra call to decide. Off (Settings → Assistant → Advanced):
// every message uses the chosen model, as before.

export type Tier = 'quick' | 'standard' | 'deep';

export interface FunnelInput {
  /** What the person typed (or the starter / button they pressed). */
  text: string;
  /** How many characters are highlighted in the file (0: nothing). */
  selection: number;
  /** The file is linked to an assignment (its rubric goes to Claude). */
  assignment: boolean;
  /** Images or PDFs attached to this message. */
  attachments: number;
  /** What kind of file is open ("document", "spreadsheet", "presentation", "image", "video", "PDF"...). */
  noun: string;
}

export interface Route {
  tier: Tier;
  model: string;
  effort: string;
  /** One plain line on why (shown in the tooltip on the answer). */
  why: string;
}

export const QUICK_MODEL = 'claude-haiku-5-5';
export const STANDARD_MODEL = 'claude-sonnet-5-5';

const DEEP = [
  /\brubric\b/i,
  /\b(grade|grading|score|marks?)\b/i,
  /\b(review|check|critique|evaluate|assess|proofread)\b.*\b(whole|entire|all of|paper|essay|draft|document|report|this)\b/i,
  /\bbefore i (submit|turn (it )?in|hand (it )?in)\b/i,
  /\b(outline|thesis|argument|counter-?argument|restructure|reorgani[sz]e)\b/i,
  /\b(rewrite|redo|revise)\b.*\b(whole|entire|all|paper|essay|document|draft)\b/i,
  /\b(sources?|citations?|cite|works cited|bibliography|references|research)\b/i,
  /\b(design|redesign|layout|deck|slides?|poster|flier|flyer|brochure|infographic|logo)\b/i,
  /\b(plan|schedule)\b.*\b(finish|on time|due)\b/i,
  /\b(analy[sz]e|compare|explain why|step by step|prove|derive)\b/i,
  /\b(formula|pivot|macro|budget|forecast|model)\b/i
];
const QUICK = [
  /\b(rephrase|reword|paraphrase|shorten|shorter|simplify|simpler|tighten|condense)\b/i,
  /\b(synonyms?|antonyms?|another word|better word)\b/i,
  /\b(define|definition|what does .{1,40} mean|meaning of)\b/i,
  /\b(translate|translation)\b/i,
  /\b(fix|correct|check)\b.*\b(grammar|spelling|typos?|punctuation|capitali[sz]ation)\b/i,
  /\b(make (it|this) )?(bold|italics?|underlined?|bigger|smaller|uppercase|lowercase|title case)\b/i,
  /\b(spell|pronounce|abbreviat)/i
];

/** Which model a message needs. `chosen` and `effort` are the Settings choices (the deep tier uses them). */
export function route(input: FunnelInput, chosen = 'claude-opus-5-5', effort = 'medium'): Route {
  const text = input.text.trim();
  const deep = (why: string): Route => ({ tier: 'deep', model: chosen, effort, why });
  // Pictures and PDFs to study, and visual work, need the strongest model.
  if (input.attachments > 0) return deep('Attached files to study');
  if (['presentation', 'image', 'video'].includes(input.noun) && !QUICK.some((r) => r.test(text))) return deep(`Design work in a ${input.noun}`);
  const hit = DEEP.find((r) => r.test(text));
  if (hit) return deep('Needs careful reading and judgment');
  // A small job on a highlighted passage: the quick model.
  if (input.selection > 0 && input.selection <= 1200 && QUICK.some((r) => r.test(text))) return { tier: 'quick', model: QUICK_MODEL, effort: 'low', why: 'A small change to the highlighted text' };
  if (!input.selection && text.length <= 120 && QUICK.slice(1, 4).some((r) => r.test(text))) return { tier: 'quick', model: QUICK_MODEL, effort: 'low', why: 'A quick lookup' };
  // A long or open request on a file with a rubric still gets the strongest model.
  if (input.assignment && text.length > 280) return deep('A long request about an assignment');
  return { tier: 'standard', model: STANDARD_MODEL, effort: effort === 'low' ? 'low' : 'medium', why: 'An ordinary edit or question' };
}

/** A tier chosen by a button that knows what it needs. */
export function routeFor(tier: Tier, chosen = 'claude-opus-5-5', effort = 'medium'): Route {
  if (tier === 'quick') return { tier, model: QUICK_MODEL, effort: 'low', why: 'A quick job' };
  if (tier === 'standard') return { tier, model: STANDARD_MODEL, effort: effort === 'low' ? 'low' : 'medium', why: 'An ordinary pass over the file' };
  return { tier, model: chosen, effort, why: 'Needs careful reading and judgment' };
}

export const TIER_LABEL: Record<Tier, string> = { quick: 'Quick', standard: 'Standard', deep: 'Deep' };

/** "Claude Haiku 5.5" from "claude-haiku-5-5". */
export const modelLabel = (m: string) =>
  m
    .replace(/^claude-/, '')
    .replace(/-(\d+)-(\d+)$/, ' $1.$2')
    .replace(/-(\d+)$/, ' $1')
    .replace(/^./, (c) => c.toUpperCase());
