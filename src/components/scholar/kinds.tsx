// How Scholar shows things: the kind of each item (with a color you can change), and links as clean buttons
// ("▶ 4.2 Exponential Functions") instead of long raw addresses.
import { useMemo } from 'react';
import { BookOpen, ClipboardList, Globe, KeyRound, Link2, ListChecks, MessageSquare, Presentation, Upload, Video, GraduationCap } from 'lucide-react';
import { api, ScholarItem, ScholarLink } from '../../lib/api';
import { useSetting, useSettings, useThemeDark } from '../../lib/settings';
import { ink } from '../../lib/themes';

// ---------- Kinds of item, grouped into a few colors ----------
export interface Category {
  id: string;
  label: string;
  color: string;
  types: string[];
}
export const CATEGORIES: Category[] = [
  { id: 'exam', label: 'Exams', color: '#f28b82', types: ['exam', 'final_exam', 'lab_practical'] },
  { id: 'quiz', label: 'Quizzes', color: '#fcad70', types: ['quiz', 'pre_lab_quiz'] },
  { id: 'homework', label: 'Assignments', color: '#8ab4f8', types: ['assignment', 'other_deadline', 'lab_handout', 'draft'] },
  { id: 'writing', label: 'Papers and projects', color: '#c58af9', types: ['paper', 'project', 'presentation', 'peer_review'] },
  { id: 'discussion', label: 'Discussions', color: '#78d9ec', types: ['discussion'] },
  { id: 'class', label: 'Lectures and labs', color: '#81c995', types: ['lecture', 'lab', 'recitation', 'seminar'] },
  { id: 'reading', label: 'Readings', color: '#c9cdd2', types: ['reading', 'weekly_reading'] },
  { id: 'date', label: 'Deadlines and breaks', color: '#fdd663', types: ['administrative_deadline', 'break', 'no_class'] }
];
const CATEGORY_OF = new Map(CATEGORIES.flatMap((c) => c.types.map((t) => [t, c])));
export const categoryOf = (type: string) => CATEGORY_OF.get(type) || CATEGORIES[2];

export const CLASS_COLORS = ['#8ab4f8', '#81c995', '#fcad70', '#c58af9', '#f28b82', '#78d9ec', '#fdd663', '#ff8bcb'];

/**
 * The colors in use: by kind of item (the default) or by class, with the student's own choices from the Colors menu.
 * Returns `item(it)` for an item's color and `course(id)` for a class's.
 */
export function useColors(courseIds: string[]) {
  const by = useSetting<'type' | 'class'>('scholar.colorBy') || 'type';
  const typeColors = useSetting<Record<string, string>>('scholar.typeColors') || {};
  const classColors = useSetting<Record<string, string>>('scholar.classColors') || {};
  // (The colours are made for dark backgrounds; on a light theme they're shown darker, so they still read.)
  const dark = useThemeDark();
  return useMemo(() => {
    const course = (id: string) => ink(classColors[id] || CLASS_COLORS[Math.max(0, courseIds.indexOf(id)) % CLASS_COLORS.length], dark);
    const type = (t: string) => {
      const c = categoryOf(t);
      return ink(typeColors[c.id] || c.color, dark);
    };
    return { by, course, type, item: (it: Pick<ScholarItem, 'type' | 'courseId'>) => (by === 'class' ? course(it.courseId) : type(it.type)) };
  }, [by, JSON.stringify(typeColors), JSON.stringify(classColors), courseIds.join(','), dark]);
}
export type Colors = ReturnType<typeof useColors>;

export function setTypeColor(id: string, color: string | null) {
  const cur = { ...(useSettings.getState().values['scholar.typeColors'] || {}) };
  if (color) cur[id] = color;
  else delete cur[id];
  useSettings.getState().set({ 'scholar.typeColors': cur });
}
export function setClassColor(id: string, color: string | null) {
  const cur = { ...(useSettings.getState().values['scholar.classColors'] || {}) };
  if (color) cur[id] = color;
  else delete cur[id];
  useSettings.getState().set({ 'scholar.classColors': cur });
}

// ---------- Missing work ----------
/** Things to hand in or do (they can be checked off), as opposed to class meetings and dates to know. */
export const TODO = new Set(['exam', 'final_exam', 'lab_practical', 'quiz', 'assignment', 'discussion', 'project', 'presentation', 'paper', 'draft', 'peer_review', 'pre_lab_quiz', 'other_deadline', 'reading', 'lab_handout']);
/** Taken in class, so they can't be "missing" afterwards the way homework can. */
const IN_CLASS = new Set(['exam', 'final_exam', 'lab_practical']);

/** Done: checked off in Kea, or graded or handed in according to the class site. */
export const isDone = (it: ScholarItem) => !!it.done || it.handIn === 'graded' || it.handIn === 'submitted';

/** Missing: past due, and the class site shows nothing handed in. */
export const isMissing = (it: ScholarItem, now = new Date()) => it.handIn === 'not_submitted' && !it.done && pastDue(it, now);

/** Past due and not checked off, but Kea can't confirm either way (no matching grade or assignment folder). */
export const isUnconfirmed = (it: ScholarItem, now = new Date()) => !it.handIn && pastDue(it, now);

function pastDue(it: ScholarItem, now: Date) {
  if (!TODO.has(it.type) || IN_CLASS.has(it.type) || isDone(it) || it.optional) return false;
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const day = it.dateEnd && it.type === 'reading' ? it.dateEnd : it.date;
  if (day < today) return true;
  if (day > today) return false;
  const due = it.due || (it.type === 'reading' ? null : '23:59');
  if (!due) return false;
  return `${pad(now.getHours())}:${pad(now.getMinutes())}` > due;
}

// ---------- Links, cleaned up ----------
type Group = 'submit' | 'reading' | 'video' | 'slides' | 'practice' | 'study' | 'platform' | 'other';
export interface CleanLink {
  url: string;
  label: string;
  /** Words that were in brackets or after a colon, shown smaller ("Instructor pick", "PDF"). */
  tags: string[];
  detail: string;
  group: Group;
  /** A matching answers/key/solutions link, shown as a small button on this one. */
  answers?: string;
}
const GROUP_LABEL: Record<Group, string> = {
  submit: 'Hand in',
  reading: 'Class readings',
  video: 'Videos',
  slides: 'Slides',
  practice: 'Practice',
  study: 'Study guides',
  platform: 'Class platforms',
  other: 'More'
};
const GROUP_ICON: Record<Group, typeof Video> = {
  submit: Upload,
  reading: BookOpen,
  video: Video,
  slides: Presentation,
  practice: ClipboardList,
  study: GraduationCap,
  platform: Globe,
  other: Link2
};
const ORDER: Group[] = ['submit', 'reading', 'video', 'slides', 'study', 'practice', 'platform', 'other'];
const TAG_WORDS: [RegExp, string][] = [
  [/instructor pick/i, 'Instructor pick'],
  [/exam study guide|study guide/i, 'Study guide'],
  [/^pdf$/i, 'PDF'],
  [/reading/i, 'Reading']
];

const ANSWERS = /\s*[-–—:]?\s*\b(answers?|answer key|key|solutions?)\s*$/i;

function groupOf(l: ScholarLink, label: string): Group {
  const s = `${l.kind} ${label} ${l.url}`;
  if (l.kind === 'submit' || /dropbox|submit|turn.?in|hand.?in|assignments\/dropbox/i.test(label)) return 'submit';
  if (l.kind === 'video' || /youtu\.?be|vimeo|\bvideo\b|lecture recording/i.test(s)) return 'video';
  if (l.kind === 'slides' || /\bslides?\b|powerpoint|\.pptx?\b/i.test(label)) return 'slides';
  if (/study guide|objectives|funsheet|review|practice exam/i.test(label)) return 'study';
  if (l.kind === 'textbook' || /textbook|e-?book|chapter reading|guided reading|\bread(ing)?\b/i.test(label)) return 'reading';
  if (/worksheet|homework|problem set|\bhw\b|exercise/i.test(label)) return 'practice';
  if (l.kind === 'platform' || /aleks|connect|pearson|mastering|webassign|cengage|mcgraw/i.test(s)) return 'platform';
  if (l.kind === 'handout') return 'practice';
  return 'other';
}

/** "4.2 video: Exponential Functions (instructor pick)" → label "4.2 Exponential Functions", tag "Instructor pick". */
export function cleanLink(l: ScholarLink): CleanLink {
  let label = String(l.label || '').replace(/�/g, '–').trim();
  const group = groupOf(l, label);
  const tags: string[] = [];
  // Bracketed notes become small tags.
  label = label.replace(/\s*\(([^)]{1,60})\)/g, (_m, inner: string) => {
    const known = TAG_WORDS.find(([re]) => re.test(inner));
    tags.push(known ? known[1] : inner.replace(/^D2L$/i, 'D2L'));
    return '';
  });
  // "D2L (Quizzes)" style labels: the area is the name.
  if (/^d2l$/i.test(label) && tags.length) label = tags.shift()!;
  // The kind is already shown by the icon: drop "video:", "Video —", "lecture video", "slides".
  if (group === 'video') label = label.replace(/^\s*video\s*[—–:-]\s*/i, '').replace(/\s*\b(lecture\s+)?video\s*[:—–-]?\s*/i, ' ');
  if (group === 'slides') label = label.replace(/^\s*lecture slides\s*[—–:-]\s*/i, '').replace(/\s*\bslides\b\s*$/i, '');
  label = label.replace(/\s*[—–]\s*/g, ' · ').replace(/\s{2,}/g, ' ').trim();
  // A long name with a description after the colon: keep the name, show the rest smaller.
  let detail = '';
  const colon = label.indexOf(': ');
  if (colon > 8 && label.length > 48) {
    detail = label.slice(colon + 2);
    label = label.slice(0, colon);
  }
  if (!label) label = GROUP_LABEL[group];
  return { url: l.url, label, tags: [...new Set(tags)], detail, group };
}

/** Clean every link, pair worksheets with their answers, and group them in a sensible order. */
export function groupLinks(links: ScholarLink[]) {
  const seen = new Set<string>();
  const clean = links.filter((l) => l?.url && !seen.has(l.url) && seen.add(l.url)).map(cleanLink);
  // "4.1 Worksheet answers" goes on "4.1 Worksheet" as its Answers button.
  const byName = new Map(clean.map((c) => [c.label.toLowerCase(), c]));
  const out: CleanLink[] = [];
  for (const c of clean) {
    if (ANSWERS.test(c.label)) {
      const base = byName.get(c.label.replace(ANSWERS, '').trim().toLowerCase());
      if (base && base !== c) {
        base.answers = c.url;
        continue;
      }
    }
    out.push(c);
  }
  return ORDER.map((g) => ({ group: g, label: GROUP_LABEL[g], icon: GROUP_ICON[g], links: out.filter((c) => c.group === g) })).filter((g) => g.links.length);
}

export const openLink = (url: string) => api.scholar.openLink(url);

/** Links as clean buttons, in groups ("Videos", "Practice"...), with Answers buttons on worksheets. */
export function LinkGroups({ links, compact = false, onOpen = openLink }: { links: ScholarLink[]; compact?: boolean; onOpen?: (url: string) => void }) {
  const openLink = onOpen;
  const groups = useMemo(() => groupLinks(links), [links]);
  if (!groups.length) return null;
  return (
    <div className={`ln-groups ${compact ? 'compact' : ''}`}>
      {groups.map((g) => (
        <div key={g.group} className={`ln-group ln-${g.group}`}>
          {!compact && <div className="tb-h">{g.label}</div>}
          <div className="ln-list">
            {g.links.map((l) => (
              <div key={l.url} className="ln-item">
                <button className="ln-main" onClick={() => openLink(l.url)} title={l.url}>
                  <g.icon size={15} className="ln-icon" />
                  <span className="ln-text">
                    <span className="ln-label">{l.label}</span>
                    {l.detail && <span className="ln-detail">{l.detail}</span>}
                  </span>
                  {l.tags.map((t) => (
                    <span key={t} className="ln-tag">
                      {t}
                    </span>
                  ))}
                </button>
                {l.answers && (
                  <button className="ln-answers" onClick={() => openLink(l.answers!)} title="Answers">
                    <KeyRound size={13} /> Answers
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** The one link that matters most for an item, for its row's quick button: where to hand it in, or its quiz. */
/** The assignment's own document (the handout or instructions file), when it has one besides the hand-in page. */
export function assignmentDoc(it: ScholarItem): ScholarLink | null {
  const own = it.links.filter((l) => l.kind !== 'submit' && !/dropbox|folder_submit|quiz_summary|discussions\/topics/i.test(l.url));
  return own.find((l) => l.kind === 'handout') || own.find((l) => /\.(pdf|docx?)\b|instructions|assignment|handout|rubric|prompt/i.test(`${l.label} ${l.url}`)) || null;
}

export function primaryLink(it: ScholarItem): { url: string; label: string; icon: typeof Upload } | null {
  // (Never one of the class site's list pages, every folder or every discussion: only this work's own page.)
  const own = it.links.filter((l) => !/folders_list|\/dropbox\/dropbox\.d2l|discussions\/List|quizzing\.d2l\?ou|quizzes_list|\/courses\/\d+\/(assignments|quizzes|discussion_topics|announcements|modules|grades)\/?([?#]|$)/i.test(l.url));
  const submit = own.find((l) => l.kind === 'submit') || own.find((l) => /dropbox|submit|discussion|quiz/i.test(`${l.label} ${l.url}`));
  // Done on an outside platform (Science Interactive, ALEKS) with no hand-in page of its own: the platform is where to go.
  const platform = (it.platformLinks || [])[0];
  if (!submit && platform && TODO.has(it.type)) return { url: platform.url, label: platform.label.replace(/^Open /, ''), icon: Globe };
  if (!submit || !TODO.has(it.type)) return null;
  const s = `${submit.label} ${submit.url}`;
  if (/discussion/i.test(s)) return { url: submit.url, label: 'Discussion', icon: MessageSquare };
  if (/quiz/i.test(s)) return { url: submit.url, label: 'Quiz', icon: ListChecks };
  if (/aleks|connect|pearson/i.test(s)) return { url: submit.url, label: cleanLink(submit).label.slice(0, 18), icon: Globe };
  return { url: submit.url, label: 'Hand in', icon: Upload };
}
