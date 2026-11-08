// Finding a setting by what the person types ("dark mode", "make text bigger", "stop the daily emails").
//
// - Instant and offline: fuzzy word matching over every setting's label, help text and group, plus the extra words
//   people use for them (KEYWORDS, SYNONYMS). Typos of a letter or two still match.
// - With a local model installed (Settings → Encyclopedia), "Ask" hands the model the best few dozen matches as a
//   numbered list and it picks the ones that fit. It only chooses numbers; it never changes a setting.
// - A suggested change ("Turn off", "Set to Dark") is offered when the words say which way, and only applied when the
//   person clicks it.
import { SECTIONS, Field, Section } from './settings';
import { api, AiEvent } from './api';

// ---------- Categories: the few places Settings is grouped into ----------
export interface Category {
  id: string;
  label: string;
  icon: string;
  /** What's inside, in a few words (the cards on Settings' first page). */
  blurb: string;
  sections: string[];
}
export const CATEGORIES: Category[] = [
  { id: 'look', label: 'Look & feel', icon: 'Palette', blurb: 'Theme, colours and sizes', sections: ['appearance'] },
  { id: 'general', label: 'General', icon: 'Settings', blurb: 'Starting up, Home, saving and updates', sections: ['general', 'home', 'files', 'updates'] },
  { id: 'editors', label: 'Documents & editors', icon: 'FileText', blurb: 'Docs, spelling, sheets, slides, PDFs, voice', sections: ['docs', 'writing', 'sheets', 'slides', 'pdf', 'code', 'video', 'voice'] },
  { id: 'school', label: 'School', icon: 'GraduationCap', blurb: 'Class checks, notifications, studying, class sites', sections: ['scholar', 'sites'] },
  { id: 'accounts', label: 'Accounts & cloud', icon: 'UserCircle', blurb: 'Kea account, Kea cloud, Google, privacy', sections: ['account', 'keacloud', 'google', 'privacy'] },
  { id: 'tools', label: 'AI & tools', icon: 'Sparkles', blurb: 'Claude, Encyclopedia, image tools, other apps', sections: ['assistant', 'lookup', 'aimodels', 'control'] },
  { id: 'help', label: 'Help & about', icon: 'Info', blurb: 'Shortcuts, feedback, licenses', sections: ['shortcuts', 'feedback', 'about'] },
];
export const categoryOf = (sectionId: string) => CATEGORIES.find((c) => c.sections.includes(sectionId)) || CATEGORIES[1];
export const sectionById = (id: string) => SECTIONS.find((s) => s.id === id);

/** The settings most people come for, shown on the first page. */
export const POPULAR = ['appearance.theme', 'appearance.scale', 'files.autosave', 'general.spellcheck', 'scholar.notifyMessages', 'keaCloud.saveTo', 'updates.autoInstall'];

// ---------- Things in Settings that aren't single settings (panels and buttons) ----------
export interface Panel {
  id: string;
  label: string;
  section: string;
  words: string;
  /** A one-line answer shown under the label (for things that live outside Settings). */
  hint?: string;
  /** Something to do right away instead of opening the page. */
  action?: 'checkUpdates' | 'print';
}
export const PANELS: Panel[] = [
  { id: 'p-google', label: 'Google account: sign in, Drive and Docs', section: 'google', words: 'google drive docs gmail sign in connect' },
  { id: 'p-control', label: 'Connect an app (MCP)', section: 'control', words: 'mcp claude code agent api automation connect app key revoke' },
  { id: 'p-aimodels', label: 'AI image tools: models', section: 'aimodels', words: 'background removal upscale download models gpu image ai' },
  { id: 'p-lookup-model', label: 'Local model for the Encyclopedia', section: 'lookup', words: 'llama qwen ai model download offline local gpu' },
  { id: 'p-account', label: 'How you use Kea, and your Kea account', section: 'account', words: 'sign in sign out log in log out profile modes personal school work hub email password leaderboard' },
  { id: 'p-cloud', label: 'Kea cloud storage', section: 'keacloud', words: 'storage space quota cloud sync documents full used free room' },
  { id: 'p-sync', label: 'Where your things sync', section: 'keacloud', words: 'sync syncing onedrive google drive dropbox folder phone devices other computers kea cloud server keas organization off where' },
  { id: 'p-history', label: 'Version history on this PC', section: 'files', words: 'version history space disk storage delete versions' },
  { id: 'p-privacy', label: 'Clear recent files, previews and descriptions', section: 'privacy', words: 'clear recent previews history data folder delete forget' },
  { id: 'p-shortcuts', label: 'Keyboard shortcuts', section: 'shortcuts', words: 'keys hotkeys shortcut keyboard ctrl' },
  { id: 'a-updates', label: 'Check for updates now', section: 'updates', words: 'check update updates new version upgrade latest', action: 'checkUpdates' },
  { id: 'a-print', label: 'Print the open file', section: 'docs', words: 'print printer printing paper copies', hint: 'Ctrl+P in any document, sheet, slide or PDF.', action: 'print' },
  { id: 'p-wordcount', label: 'Word count and word goal', section: 'docs', words: 'word count words characters goal length how long essay limit', hint: 'At the bottom of every document. Click it to set a word goal.' },
  { id: 'p-feedback', label: 'Send feedback', section: 'feedback', words: 'bug report problem idea suggestion feedback contact help' },
  { id: 'p-about', label: 'About Kea and licenses', section: 'about', words: 'version license open source about credits' },
];

// ---------- Extra words people use ----------
/** Per setting: the words someone might type for it that its label and help don't use. */
const KEYWORDS: Record<string, string> = {
  'appearance.theme': 'dark mode light mode night mode colour color scheme black white sepia dim',
  'appearance.accent': 'color colour highlight accent tint',
  'appearance.scale': 'zoom bigger smaller larger text size font size everything ui scale screen words too small hard to read tiny',
  'appearance.reduceMotion': 'animation motion',
  'appearance.uiFont': 'font typeface',
  'appearance.menuFont': 'text size menus bigger',
  'general.spellcheck': 'spelling spell check typos red underline',
  'general.startup': 'startup launch open restore tabs',
  'general.newKind': 'new file ctrl n',
  'user.name': 'name author mla',
  'files.autosave': 'auto save automatically saving',
  'files.versions': 'history undo restore older versions backup',
  'files.defaultFolder': 'save location where files go folder',
  'files.recovery': 'crash recover lost',
  'scholar.notifyMessages': 'notifications alerts emails inbox mail',
  'scholar.notifyAnnouncements': 'notifications alerts news',
  'scholar.notifyGrades': 'notifications alerts grades scores marks',
  'scholar.notifyQuietFrom': 'do not disturb quiet hours night silence',
  'scholar.notifyQuietTo': 'do not disturb quiet hours night silence',
  'scholar.notifyQuietClasses': 'mute class quiet',
  'scholar.scanEvery': 'daily check how often scan refresh',
  'scholar.inboxMinutes': 'how often check inbox messages',
  'scholar.pcSync': 'sync devices computers',
  'scholar.background': 'tray background closed running',
  'hub.remindMinutes': 'notification reminder alert class session meeting',
  'updates.autoCheck': 'update upgrade new version',
  'updates.autoInstall': 'update install restart',
  'doc.font': 'font typeface default font',
  'doc.size': 'font size text size bigger',
  'voice.model': 'dictation speech to text microphone',
  'sites.dark': 'dark mode d2l canvas brightspace',
  'sites.adblock': 'ads adblock ublock tracker block',
  'pdf.darkPages': 'dark mode pdf pages night white',
  'privacy.log': 'logs troubleshooting',
  'keaCloud.enabled': 'storage sync cloud documents',
  'keaCloud.saveTo': 'save where cloud storage',
  'study.sound': 'sound audio beep noise',
  'assistant.enabled': 'claude ai chat assistant turn off claude hide claude disable claude remove claude no ai',
  'lookup.useModel': 'ai model local llama',
  'grammar.enabled': 'grammar check writing',
};

/** Words that mean the same thing, in either direction of how people and Kea say it. */
const SYNONYMS: Record<string, string[]> = {
  dark: ['theme', 'night', 'black'],
  light: ['theme', 'white'],
  night: ['dark', 'quiet'],
  color: ['colour', 'theme', 'accent'],
  colour: ['color', 'theme', 'accent'],
  bigger: ['size', 'scale', 'zoom', 'font'],
  larger: ['size', 'scale', 'zoom', 'font'],
  big: ['size', 'scale', 'zoom'],
  smaller: ['size', 'scale', 'zoom', 'font'],
  small: ['size', 'scale'],
  text: ['font', 'size'],
  font: ['text', 'typeface'],
  zoom: ['scale', 'size'],
  notification: ['notify', 'remind', 'alert'],
  notify: ['notification', 'remind', 'alert'],
  alert: ['notify', 'notification', 'remind'],
  remind: ['notify', 'reminder'],
  reminder: ['remind', 'notify'],
  ping: ['notify'],
  popup: ['notify'],
  email: ['message', 'notify', 'signature', 'mail'],
  mail: ['message', 'email'],
  inbox: ['message', 'inbox'],
  daily: ['day', 'every'],
  storage: ['storage', 'history', 'version', 'cloud', 'quota', 'space'],
  space: ['storage', 'history', 'quota'],
  disk: ['storage', 'history'],
  sync: ['cloud', 'device', 'drive', 'hub'],
  syncing: ['sync', 'cloud', 'device'],
  backup: ['version', 'history', 'sync'],
  save: ['autosave', 'saving'],
  saving: ['save', 'autosave'],
  language: ['dialect', 'lang'],
  dictation: ['voice'],
  speech: ['voice'],
  mic: ['voice', 'microphone'],
  microphone: ['voice'],
  ai: ['model', 'claude', 'assistant'],
  claude: ['assistant'],
  update: ['updates', 'version'],
  upgrade: ['update', 'version'],
  printer: ['print'],
  printing: ['print'],
  count: ['word', 'length'],
  length: ['count', 'word'],
  goal: ['target', 'count'],
  password: ['account', 'sign'],
  login: ['account', 'sign'],
  signin: ['account', 'sign'],
  ads: ['adblock', 'block'],
  sound: ['sounds', 'audio'],
  shortcut: ['keyboard', 'shortcuts'],
  hotkey: ['keyboard', 'shortcut'],
  keys: ['keyboard', 'shortcut'],
  spell: ['spelling', 'spellcheck'],
  spelling: ['spell', 'spellcheck', 'grammar'],
  launch: ['startup', 'start'],
  startup: ['start', 'starts'],
  phone: ['device', 'sync', 'mobile'],
  mobile: ['phone', 'device'],
  cloud: ['drive', 'sync', 'storage'],
  onedrive: ['drive', 'cloud', 'sync'],
  animation: ['motion', 'animations'],
  tiny: ['size', 'scale', 'font'],
  read: ['size', 'font', 'text'],
  screen: ['everything', 'scale', 'size'],
  word: ['text', 'font'],
};
/** "Too small" asks for bigger, "too big" for smaller (checked before the plain up/down words). */
const WANT_UP = /\btoo (small|tiny|little|low|short|quiet)\b|\bhard to (read|see)\b|\bcan'?t (read|see)\b/;
const WANT_DOWN = /\btoo (big|large|huge|high|long|loud)\b/;

const STOP = new Set(
  'i me my mine the a an to of in on for and or is it its how do does can could want wanna make get turn set change where what please kea setting settings option options be more less stop off disable enable show hide no not dont don t too so with about all any them these those this that from at by up down should would like let lets go just keep stuff thing things there here every each when im ive'.split(' ')
);
const NEG = /\b(stop|off|disable|turn off|no more|don'?t|never|without|hide|mute|silence|quiet|less|fewer|remove)\b/;
const POS = /\b(turn on|enable|start|show|want|always|allow|more)\b/;
const UP = /\b(bigger|larger|increase|more|higher|bolder|longer|big)\b/;
const DOWN = /\b(smaller|decrease|less|lower|shorter|tiny|small)\b/;

// ---------- Matching ----------
const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
function stem(w: string) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 4 && w.endsWith('es') && /(ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
const words = (s: string) => norm(s).split(' ').filter(Boolean).map(stem);

function lev(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
function sim(q: string, d: string) {
  if (q === d) return 1;
  if (q.length >= 3 && d.startsWith(q)) return 0.85;
  if (d.length >= 4 && q.startsWith(d)) return 0.7;
  if (q.length >= 4 && d.length >= 4) {
    const e = lev(q, d, 2);
    if (e === 1) return 0.7;
    if (e === 2 && q.length >= 7) return 0.5;
  }
  return 0;
}

type HitBase = { kind: 'field'; key: string; field: Field; section: Section } | { kind: 'panel'; key: string; panel: Panel; section: Section };
export type Hit = HitBase & { score: number };

interface Doc {
  hit: HitBase;
  /** word -> weight (label 3, extra words 2.5, group/section 1.5, help 1) */
  w: Map<string, number>;
  label: string;
  extra: string;
}
let docs: Doc[] | null = null;
function index(): Doc[] {
  if (docs) return docs;
  docs = [];
  const add = (w: Map<string, number>, text: string, weight: number) => {
    for (const x of words(text)) if (!STOP.has(x) && (w.get(x) ?? 0) < weight) w.set(x, weight);
  };
  for (const s of SECTIONS) {
    let group = '';
    for (const f of s.fields) {
      group = f.group || group;
      const w = new Map<string, number>();
      add(w, f.help || '', 1);
      add(w, `${s.label} ${group} ${categoryOf(s.id).label}`, 1.5);
      add(w, (f.options || []).map((o) => o.label).join(' '), 1);
      add(w, KEYWORDS[f.key] || '', 3);
      add(w, f.label, 3);
      docs.push({ hit: { kind: 'field', key: f.key, field: f, section: s }, w, label: norm(f.label), extra: norm(KEYWORDS[f.key] || '') });
    }
  }
  for (const p of PANELS) {
    const s = sectionById(p.section);
    if (!s) continue;
    const w = new Map<string, number>();
    add(w, s.label, 1.5);
    add(w, p.words, 2.5);
    add(w, p.label, 3);
    docs.push({ hit: { kind: 'panel', key: p.id, panel: p, section: s }, w, label: norm(p.label), extra: norm(p.words) });
  }
  return docs;
}

/** The words of a request that carry meaning (no "I want to", "please", "turn off"). */
export const queryWords = (q: string) => words(q).filter((x) => !STOP.has(x));

/** Below this, a match is a coincidence ("zebra crossing" finding "Crossref"), not an answer. */
const MIN_SCORE = 0.9;

/**
 * Settings that match what was typed, best first. `loose` keeps anything that matches any word (the candidates the
 * local model chooses from); otherwise at least half the words must match and weak matches are left out.
 *
 * Ranking: a word found as typed (or as one of its synonyms) anywhere beats a near-spelling, which only counts when
 * nothing has the word itself ("print" finds printing, not "points"). Label words count more than help text, a label
 * the request names almost entirely ranks first, and "turn off / hide / show X" prefers the switch for X.
 */
export function searchSettings(q: string, opts: { values?: Record<string, any>; loose?: boolean; limit?: number } = {}): Hit[] {
  const qw = queryWords(q);
  const phrase = norm(q);
  if (!qw.length) return [];
  const all = index();
  const schoolOff = opts.values?.['scholar.enabled'] === false;
  const tries = (t: string): [string, number][] => [[t, 1], ...(SYNONYMS[t] || []).map((x) => [stem(x), 0.8] as [string, number])];
  // Typo tolerance only for words nothing contains as typed.
  const typos = new Map(qw.map((t) => [t, !all.some((d) => tries(t).some(([x]) => [...d.w.keys()].some((dw) => sim(x, dw) >= 0.85)))]));
  const toggleIntent = NEG.test(' ' + q.toLowerCase() + ' ') || POS.test(' ' + q.toLowerCase() + ' ');
  const out: Hit[] = [];
  for (const d of all) {
    if (d.hit.kind === 'field' && d.hit.field.when && opts.values && !d.hit.field.when(opts.values)) continue;
    // School's settings stay out of the way while School is off.
    if (schoolOff && categoryOf(d.hit.section.id).id === 'school') continue;
    let total = 0;
    let matched = 0;
    const labelWords = words(d.label).filter((x) => !STOP.has(x));
    let labelHits = 0;
    for (const t of qw) {
      let best = 0;
      for (const [x, k] of tries(t))
        for (const [dw, weight] of d.w) {
          const s = sim(x, dw);
          if (s >= 0.85 || typos.get(t)) best = Math.max(best, s * weight * k);
        }
      if (best > 0) matched++;
      if (tries(t).some(([x]) => labelWords.some((lw) => sim(x, lw) >= 0.85))) labelHits++;
      total += best;
    }
    if (!matched) continue;
    const coverage = matched / qw.length;
    if (!opts.loose && coverage < 0.5) continue;
    let score = total * (0.4 + 0.6 * coverage);
    if (phrase.length > 2 && (d.label.includes(phrase) || d.extra.includes(phrase))) score += 4;
    // A label made almost entirely of the request's words is the obvious answer.
    if (labelWords.length) score += 1.5 * Math.min(1, labelHits / labelWords.length);
    if (toggleIntent && d.hit.kind === 'field' && d.hit.field.type === 'toggle') {
      score *= 1.25;
      if (/\.enabled$/.test(d.hit.key) || /^(show|use)\b/i.test(d.hit.field.label)) score *= 1.3;
    }
    if (POPULAR.includes(d.hit.key) || (d.hit.kind === 'panel' && d.hit.panel.action)) score *= 1.1;
    if (d.hit.kind === 'field' && d.hit.field.advanced) score *= 0.85;
    out.push({ ...d.hit, score } as Hit);
  }
  out.sort((a, b) => b.score - a.score);
  // Weak tails add noise: keep what's within reach of the best match.
  const top = out[0]?.score ?? 0;
  const kept = opts.loose ? out : out.filter((h) => h.score >= Math.max(top * 0.3, MIN_SCORE));
  return kept.slice(0, opts.limit ?? 40);
}

// ---------- A suggested change (applied only when clicked) ----------
export interface Suggestion {
  value: any;
  label: string;
}
export function suggestChange(q: string, f: Field, value: any): Suggestion | null {
  const t = ' ' + q.toLowerCase() + ' ';
  const neg = NEG.test(t);
  const pos = !neg && POS.test(t);
  const up = !WANT_DOWN.test(t) && (WANT_UP.test(t) || UP.test(t));
  const down = !up && (WANT_DOWN.test(t) || DOWN.test(t));
  if (f.type === 'toggle') {
    if (neg && value) return { value: false, label: 'Turn off' };
    if (pos && !value) return { value: true, label: 'Turn on' };
    return null;
  }
  if (f.type === 'select' && f.options) {
    // A word of the request names one of the choices ("dark mode" -> Dark).
    const labelWords = new Set(words(f.label));
    const qw = queryWords(q).filter((x) => !labelWords.has(x));
    const named = f.options.find((o) => {
      const ow = words(o.label);
      return qw.some((x) => ow[0] === x);
    });
    if (named && String(named.value) !== String(value)) return { value: named.value, label: `Set to ${named.label}` };
    const i = f.options.findIndex((o) => String(o.value) === String(value));
    const ordered = f.options.every((o) => typeof o.value === 'number');
    if (ordered && i >= 0) {
      if (up && i < f.options.length - 1) return { value: f.options[i + 1].value, label: `Set to ${f.options[i + 1].label}` };
      if (down && i > 0) return { value: f.options[i - 1].value, label: `Set to ${f.options[i - 1].label}` };
    }
    if (neg) {
      const off = f.options.find((o) => /^(off|never|don.?t|no )/i.test(o.label) || o.value === 0 || o.value === 'off');
      if (off && String(off.value) !== String(value)) return { value: off.value, label: off.label };
    }
    return null;
  }
  if ((f.type === 'number' || f.type === 'range') && typeof value === 'number') {
    const step = f.step || 1;
    if (up && (f.max == null || value + step <= f.max)) return { value: +(value + step).toFixed(4), label: `Set to ${+(value + step).toFixed(4)}${f.unit ? ' ' + f.unit : ''}` };
    if (down && (f.min == null || value - step >= f.min)) return { value: +(value - step).toFixed(4), label: `Set to ${+(value - step).toFixed(4)}${f.unit ? ' ' + f.unit : ''}` };
  }
  return null;
}

// ---------- Asking the local model ----------
let readyAt = 0;
let ready = false;
/** A local model is installed (Settings → Encyclopedia), so "Ask" can understand a whole request. */
export async function modelAvailable() {
  if (Date.now() - readyAt < 30000) return ready;
  const st = await api.ai?.state().catch(() => null);
  ready = !!st?.models.find((m) => m.tier === st.settings.tier)?.installed;
  // (Only a yes is remembered: a model still loading or just downloaded is checked again next time.)
  readyAt = ready ? Date.now() : 0;
  return ready;
}

/**
 * The local model reads the request and picks, by number, up to three settings from the closest matches. Returns
 * null when no model is installed or it doesn't answer in time (word matching stays on screen either way).
 */
export async function askModel(q: string, values: Record<string, any>): Promise<Hit[] | null> {
  if (!(await modelAvailable())) return null;
  let cands = searchSettings(q, { values, loose: true, limit: 30 });
  if (cands.length < 8) {
    // Few word matches: give it the everyday settings too, so it has real choices.
    const more = POPULAR.map((k) => index().find((d) => d.hit.key === k)?.hit).filter(Boolean) as Hit[];
    cands = [...cands, ...more.filter((m) => !cands.some((c) => c.key === m.key)).map((m) => ({ ...m, score: 0 }))];
  }
  if (!cands.length) return [];
  const list = cands.map((h, i) => `${i + 1}. ${h.kind === 'field' ? h.field.label : h.panel.label} (${h.section.label})${h.kind === 'field' && h.field.help ? ` - ${h.field.help.split(/(?<=\.)\s/)[0].slice(0, 110)}` : ''}`).join('\n');
  const schema = { type: 'object', properties: { picks: { type: 'array', items: { type: 'integer', enum: cands.map((_, i) => i + 1) }, maxItems: 3 } }, required: ['picks'] };
  try {
    const id = await api.ai.generate({
      system: 'You help people find the right setting in an app. You only choose from the numbered settings you are given. Reply only with the JSON.',
      prompt: `Someone wrote: "${q.slice(0, 200)}"\n\nSettings:\n${list}\n\nWhich settings (up to 3, best first) are what they are looking for? If none fit, return an empty list.`,
      jsonSchema: schema,
      temperature: 0,
      maxTokens: 40,
    });
    const text = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => (off(), api.ai.stop(id), reject(new Error('slow'))), 25000);
      const off = api.ai.onEvent((e: AiEvent) => {
        if (e.id !== id || e.type === 'token') return;
        clearTimeout(timer);
        off();
        if (e.type === 'done') resolve(e.text);
        else reject(new Error(e.message));
      });
    });
    const picks: number[] = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || '{}').picks || [];
    return [...new Set(picks)].map((n) => cands[n - 1]).filter(Boolean);
  } catch {
    return null;
  }
}

/** The first sentence of a help text, for the one-line hint (the rest shows on request). */
export function hintOf(help: string | undefined): { hint: string; more: boolean } {
  if (!help) return { hint: '', more: false };
  if (help.length <= 90) return { hint: help, more: false };
  const m = help.match(/^(.{20,140}?[.!?])\s/);
  const hint = m ? m[1] : help.slice(0, 90).replace(/\s+\S*$/, '') + '…';
  return { hint, more: true };
}
