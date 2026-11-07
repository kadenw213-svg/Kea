// What an item offers, decided in one place for every screen (the PC's rows and panel in ScholarScreen.tsx, the phone's
// list and item sheet in mobile/src/App.tsx). Plain TypeScript, no React, so the rules are tested on their own
// (test/scholar/itemRules.test.mjs).
//
// The rules (each is a test):
//  1. A button or link exists only when it fits the item. A place is matched to the KIND of work: a discussion is
//     posted in its topic, a peer review is done on its assignment page or topic, a test is taken in its quiz. Never
//     "Take the quiz" on a discussion.
//  2. A link that doesn't fit as the item's main button is never silently dropped: it stays in the panel's links,
//     under More. Only a quiz on a post (a discussion or peer review) is left out entirely, since it's always a
//     mismatch.
//  3. Locked work (it opens later on the class site) has no buttons at all: its links lead to a locked page.
//  4. The hand-in sentence is built from the main button Kea actually shows, never from something it refused (a lab
//     discussion is posted in its topic, even though the lab is done on Science Interactive). Taken-in-class tests say
//     so; "hidden or locked" is said only of work that's handed in online.
//  5. Study is offered only for work practice questions help with (an allow-list, never a deny-list), and only for
//     chapters that are the item's own, not ones guessed from its week.
import type { ScholarItem, ScholarLink } from '../../lib/api';

// ---------- Kinds of item ----------
/** Things to hand in or do (they can be checked off), as opposed to class meetings and dates to know. */
export const TODO = new Set(['exam', 'final_exam', 'lab_practical', 'quiz', 'assignment', 'discussion', 'project', 'presentation', 'paper', 'draft', 'peer_review', 'pre_lab_quiz', 'other_deadline', 'reading', 'lab_handout']);
/** Taken in class, at a time and place (they can't be "missing" afterwards the way homework can). */
export const IN_CLASS = new Set(['exam', 'final_exam', 'lab_practical']);
/** Posted on the class site: a discussion (in its topic) or a peer review (on its assignment page or topic). */
export const POSTS = new Set(['discussion', 'peer_review']);
/** Tests: taken in a quiz (or in class). */
export const TESTS = new Set(['quiz', 'exam', 'final_exam', 'midterm', 'pre_lab_quiz', 'lab_practical']);
/** Due work, as counted in "N due": TODO, without reminders and readings. (Class meetings never count; db.cjs DUE_KINDS is the same list.) */
export const COUNTS_AS_DUE = new Set([...TODO].filter((t) => t !== 'other_deadline' && t !== 'reading'));

export const TYPE_LABEL: Record<string, string> = {
  lecture: 'Lecture',
  class_session: 'Class session',
  lab: 'Lab',
  recitation: 'Recitation',
  seminar: 'Seminar',
  exam: 'Exam',
  final_exam: 'Final exam',
  lab_practical: 'Lab practical',
  quiz: 'Quiz',
  assignment: 'Assignment',
  discussion: 'Discussion',
  project: 'Project',
  presentation: 'Presentation',
  paper: 'Paper',
  draft: 'Draft',
  peer_review: 'Peer review',
  lab_handout: 'Lab handout',
  pre_lab_quiz: 'Pre-lab quiz',
  administrative_deadline: 'Deadline',
  break: 'Break',
  no_class: 'No class',
  reading: 'Reading',
  other_deadline: 'To do',
  weekly_reading: 'This week',
  work_shift: 'Work shift',
  office_hours: 'Office hours',
  midterm: 'Midterm'
};
/** An item's kind in words (a lab report filed as a lab handout reads "Lab report"; an unknown kind never shows raw). */
export const typeLabel = (it: Pick<ScholarItem, 'type' | 'title'>) =>
  it.type === 'lab_handout' && /\breport\b/i.test(it.title) ? 'Lab report' : TYPE_LABEL[it.type] || it.type.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

// ---------- Places on the class site ----------
/** What a class-site page is, from its address: a quiz, a discussion topic, a hand-in folder, or something else. */
export function placeKind(url: string): 'quiz' | 'discussion' | 'folder' | 'other' {
  if (/quiz_summary|\/quizzing\/|\/quizzes\/\d/i.test(url)) return 'quiz';
  if (/discussions\/topics\/\d|\/discussion_topics\/\d/i.test(url)) return 'discussion';
  if (/folder_submit|\/dropbox\/|\/assignments\/\d/i.test(url)) return 'folder';
  return 'other';
}
/** A class site's list page (every folder, every quiz, every discussion), never one piece of work's own page. */
export const LIST_PAGE = /folders_list|\/dropbox\/dropbox\.d2l|discussions\/List|quizzing\.d2l\?ou|quizzes_list|\/courses\/\d+\/(assignments|quizzes|discussion_topics|announcements|modules|grades)\/?([?#]|$)/i;

/** The hand-in folder's id in a class-site address (D2L "?db=905", Canvas "/assignments/301"), or null. */
export function folderIdOf(url: string | null | undefined): string | null {
  const s = String(url || '');
  return (/[?&]db=(\d+)/i.exec(s) || /\/assignments\/(\d+)/i.exec(s) || /\/dropbox\/[^?]*?\/(\d+)\b/i.exec(s) || [])[1] || null;
}

// ---------- Outside platforms ----------
// Each by its own name, never the link's text cut short ("Mastering Physics: Cha"). "Connect" only on McGraw Hill's
// own address or name: the word alone is too common.
const PLATFORMS: [RegExp, string][] = [
  [/aleks/i, 'ALEKS'],
  [/science\s*interactive|scienceinteractive|\bsci\.?\s*interactive/i, 'Science Interactive'],
  [/mastering\s*(physics|chemistry|biology|a&p|astronomy|engineering|geology)?|masteringphysics|masteringchemistry|masteringbiology/i, 'Mastering'],
  [/mylab|my\s*lab\s*(math|statistics|economics|accounting)|mymathlab|mystatlab/i, 'MyLab'],
  [/webassign/i, 'WebAssign'],
  [/wileyplus|wiley\s*plus/i, 'WileyPLUS'],
  [/mindtap/i, 'MindTap'],
  [/cengage/i, 'Cengage'],
  [/connect\.mheducation|mcgraw[\s-]*hill\s*connect|\bmh\s*connect\b/i, 'Connect'],
  [/achieve\.macmillan|macmillan\s*achieve|achieve\.bfwpub|\bsapling/i, 'Achieve'],
  [/pearson/i, 'Pearson'],
  [/labster/i, 'Labster'],
  [/hawkes/i, 'Hawkes Learning']
];
/** The outside platform a link or text names ("ALEKS", "Mastering", "Science Interactive"), or null. */
export function platformName(text: string): string | null {
  for (const [re, name] of PLATFORMS) if (re.test(text)) return name;
  return null;
}

/** Cut text at a word boundary with an ellipsis, never mid-word. */
export function shorten(s: string, n: number) {
  const t = s.trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n + 1).replace(/\s+\S*$/, '').replace(/[\s,;:·–-]+$/, '');
  return `${cut || t.slice(0, n)}…`;
}

// ---------- The one main button ----------
export type QuickKind = 'folder' | 'discussion' | 'peer' | 'quiz' | 'platform';
export interface Quick {
  url: string;
  /** The button's words: "Hand in", "Discussion", "Peer review", "Quiz", or the platform's name. */
  label: string;
  kind: QuickKind;
}

/** Whether a place fits the work as its main button. */
export function fits(it: Pick<ScholarItem, 'type' | 'title'>, l: ScholarLink) {
  const k = placeKind(l.url);
  // A peer review is done on the assignment's page (Canvas) or in a discussion topic.
  if (it.type === 'peer_review') return k === 'discussion' || k === 'folder' || (k === 'other' && l.kind === 'submit' && /discussion|peer/i.test(l.label));
  if (POSTS.has(it.type)) return k === 'discussion' || (k === 'other' && l.kind === 'submit' && /discussion/i.test(l.label));
  if (TESTS.has(it.type)) return k !== 'discussion';
  if (k === 'quiz') return /quiz|test|exam/i.test(it.title);
  if (k === 'discussion') return /discussion|post\b|forum/i.test(it.title);
  return true;
}
/** A link that's always a mismatch for the item, left out everywhere (a quiz on a discussion or peer review). */
export const neverFor = (it: Pick<ScholarItem, 'type'>, l: ScholarLink) => POSTS.has(it.type) && placeKind(l.url) === 'quiz';

/** Locked: it opens later on the class site, so its links lead to a locked page. */
export const isLocked = (it: Pick<ScholarItem, 'opensAt'>, now = Date.now()) => !!it.opensAt && new Date(it.opensAt).getTime() > now - 60000;

/** The one link that matters most for an item, for its row's button and its panel: where to hand it in, or its quiz. */
export function quickLink(it: ScholarItem, now = Date.now()): Quick | null {
  if (!TODO.has(it.type) || isLocked(it, now)) return null;
  // (Never one of the class site's list pages, every folder or every discussion: only this work's own page; and only a
  // place of the work's own kind.)
  const own = it.links.filter((l) => !LIST_PAGE.test(l.url) && fits(it, l));
  const rank = (l: ScholarLink) => (TESTS.has(it.type) ? (placeKind(l.url) === 'quiz' ? 0 : 1) : it.type === 'discussion' ? (placeKind(l.url) === 'discussion' ? 0 : 1) : placeKind(l.url) === 'folder' ? 0 : 1);
  const best = (list: ScholarLink[]) => [...list].sort((a, b) => rank(a) - rank(b))[0];
  const submit = best(own.filter((l) => l.kind === 'submit')) || best(own.filter((l) => placeKind(l.url) !== 'other'));
  // Done on an outside platform (Science Interactive, ALEKS) with no hand-in page of its own: the platform is where to
  // go. (Not for a post: it's posted on the class site, whatever platform it's about.)
  const platform = (it.platformLinks || [])[0];
  if (!submit) return platform && !POSTS.has(it.type) ? { url: platform.url, label: platformName(`${platform.label} ${platform.url}`) || shorten(platform.label.replace(/^Open /, ''), 22), kind: 'platform' } : null;
  const k = placeKind(submit.url);
  if (it.type === 'peer_review') return { url: submit.url, label: 'Peer review', kind: 'peer' };
  if (k === 'discussion' || POSTS.has(it.type)) return { url: submit.url, label: 'Discussion', kind: 'discussion' };
  if (k === 'quiz') return { url: submit.url, label: 'Quiz', kind: 'quiz' };
  const plat = k === 'other' ? platformName(`${submit.label} ${submit.url}`) : null;
  if (plat) return { url: submit.url, label: plat, kind: 'platform' };
  return { url: submit.url, label: 'Hand in', kind: 'folder' };
}

/** The panel's main button, in words. */
export const quickVerb = (q: Quick) => (q.kind === 'folder' ? 'Open hand-in folder' : q.kind === 'discussion' ? 'Open the discussion' : q.kind === 'peer' ? 'Open the peer review' : q.kind === 'quiz' ? 'Open the quiz' : `Open ${q.label}`);

/** The assignment's own document (the handout or instructions file), when it has one besides the hand-in page. */
export function assignmentDoc(it: ScholarItem): ScholarLink | null {
  if (isLocked(it)) return null;
  const own = it.links.filter((l) => l.kind !== 'submit' && !/dropbox|folder_submit|quiz_summary|discussions\/topics/i.test(l.url));
  return own.find((l) => l.kind === 'handout') || own.find((l) => /\.(pdf|docx?)\b|instructions|assignment|handout|rubric|prompt/i.test(`${l.label} ${l.url}`)) || null;
}

/**
 * Every link an item's panel shows, each once: the main button, the platforms it's done on, its own document, and the
 * rest (grouped by LinkGroups). Links a guide step already opens aren't repeated; a submit link that isn't the main
 * button is kept under More (rule 2); nothing at all for locked work (rule 3).
 */
export function panelLinks(it: ScholarItem, guide?: { steps?: { links?: { url: string }[] }[]; submit?: { url?: string } } | null, now = Date.now()) {
  const quick = quickLink(it, now);
  if (isLocked(it, now)) return { quick: null, platforms: [] as ScholarLink[], doc: null, rest: [] as ScholarLink[] };
  const platforms = (it.platformLinks || []).filter((l) => l.url !== quick?.url);
  const inGuide = new Set((guide?.steps || []).flatMap((s) => (s.links || []).map((l) => l.url)).concat(guide?.submit?.url ? [guide.submit.url] : []));
  const docRaw = assignmentDoc(it);
  const doc = docRaw && !inGuide.has(docRaw.url) ? docRaw : null;
  const shown = new Set([quick?.url, doc?.url, ...platforms.map((l) => l.url)].filter(Boolean) as string[]);
  const seen = new Set<string>();
  const rest = [...it.links, ...it.weeklyLinks]
    .filter((l) => l?.url && !shown.has(l.url) && !inGuide.has(l.url) && !neverFor(it, l) && !seen.has(l.url) && !!seen.add(l.url))
    // (A hand-in link that isn't this work's main button is shown as a plain page, never as a second "Hand in".)
    .map((l) => (l.kind === 'submit' ? { ...l, kind: 'page', group: 'other' as const } : l));
  return { quick, platforms, doc, rest };
}

// ---------- Where it's handed in, in words ----------
const shortRoom = (loc: string) => (loc === 'Online' ? 'Online' : loc.split(',').pop()!.trim());
/**
 * The panel's hand-in line, or null when there's nothing to say. Built from the main button (rule 4). `muted`: a
 * caution rather than a fact.
 */
export function handInText(it: ScholarItem, now = Date.now()): { text: string; muted?: boolean; opens?: boolean } | null {
  if (!TODO.has(it.type) || ['weekly_reading', 'lecture', 'reading'].includes(it.type)) return null;
  if (isLocked(it, now)) return { text: 'Opens', opens: true };
  const q = quickLink(it, now);
  if (q?.kind === 'discussion') return { text: 'Hand in: post in the discussion (the button below opens its topic)' };
  if (q?.kind === 'peer') return { text: 'Hand in: do the review on its page on your class site (the button below opens it)' };
  if (q?.kind === 'quiz') return { text: 'Taken on your class site: the button below opens the quiz' };
  if (q?.kind === 'platform') return { text: `Done on ${q.label}: the button below opens it` };
  if (q?.kind === 'folder') return { text: 'Hand in: the assignment folder on your class site' };
  // Taken in class: an exam or practical with a time or a room.
  if (IN_CLASS.has(it.type) && (it.start || it.location)) return { text: `Taken in class${it.location && it.location !== 'Online' ? `, ${shortRoom(it.location)}` : ''}` };
  if (it.location && /class|lab|room|hall|in person/i.test(it.location)) return { text: 'Hand in: in class' };
  // A reminder ("Bring lab coat and goggles") isn't handed in anywhere.
  if (it.type === 'other_deadline') return null;
  if (POSTS.has(it.type)) return { text: 'No discussion page on your class site yet (it may still be hidden)', muted: true };
  return { text: 'No hand-in page on your class site yet (it may still be hidden or locked)', muted: true };
}
/**
 * The "Done on" line: each outside platform, unless the hand-in line already names it. On a post it reads "About the
 * lab on" (it's posted on the class site, not done on the platform).
 */
export function platformLine(it: ScholarItem, now = Date.now()): string | null {
  const list = (it.platformLinks || []).map((l) => platformName(`${l.label} ${l.url}`) || shorten(l.label.replace(/^Open /, ''), 30));
  if (!list.length) return null;
  const q = quickLink(it, now);
  if (q?.kind === 'platform' && list.length === 1 && list[0] === q.label) return null;
  return `${POSTS.has(it.type) ? 'About the lab on' : 'Done on'}: ${[...new Set(list)].join(', ')}`;
}

// ---------- Work it goes with ----------
/** The half of a discussion a title names, in brackets or after a dash or colon (as electron/scholar/db.cjs reads it). */
export const POST_HALF = /\s*(?:\((?:initial|response|replies|reply)[^)]*\)|[-–—:]\s*(?:initial\s+posts?|response\s+posts?|responses|replies|reply)\b[^]*)$/i;
type Related = NonNullable<ScholarItem['related']>[number];
/** How a related item reads on a panel: "Initial post: Discussion 6", "Goes with: Online Assignment 9". */
export function relatedText(r: Related): { prefix: string; title: string } {
  if (r.why === 'post') {
    const half = /\binitial/i.test(r.title) ? 'Initial post' : /\b(respon|repl)/i.test(r.title) ? 'Replies' : 'The other half';
    return { prefix: `${half}: `, title: r.title.replace(POST_HALF, '') || r.title };
  }
  if (r.why === 'lab' && r.group) return { prefix: '', title: r.title };
  return { prefix: r.why === 'lab' ? 'Goes with the lab: ' : 'Goes with: ', title: r.title };
}

// ---------- Guides ----------
/** Calendar entries the guides run never writes a guide for (electron/scholar/guides.cjs NOT_WORK: keep the two alike). */
const NOT_GUIDED = new Set(['reading', 'weekly_reading', 'lecture', 'recitation', 'seminar', 'office_hours', 'break', 'no_class', 'administrative_deadline', 'other_deadline']);
/** Whether the daily check will write this item a guide (guides.cjs needing): work still ahead, or past and missing. */
export function willGuide(it: ScholarItem, now = new Date()) {
  if (NOT_GUIDED.has(it.type) || it.done || !it.date || it.hub) return false;
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return it.date >= today || it.handIn === 'not_submitted';
}

// ---------- Study ----------
/** Work practice questions help with (rule 5). Writing work, reminders, handouts and dates never get Study. */
const STUDY_KINDS = new Set(['exam', 'final_exam', 'midterm', 'quiz', 'pre_lab_quiz', 'lab_practical', 'reading', 'lecture', 'assignment']);
/** The chapters an item can be studied for: its own ones (never guessed from its week), only for kinds Study fits. */
export function studyChapters(it: ScholarItem, now = Date.now()): string[] {
  if (!STUDY_KINDS.has(it.type) || isLocked(it, now)) return [];
  return it.readings.filter((r) => !r.inferred && !r.unlisted).map((r) => r.chapter);
}
