// Running the estimated grade on the person's own Claude (their plan through Claude Code, or their API key: the
// same route as the Claude tab), and keeping the last result with the file and the assignment.
import { create } from 'zustand';
import { api } from './api';
import { setting } from './settings';
import { uid } from './util';
import { editorRegistry } from '../store';
import { assignmentOf, assignmentSig, fileKey, onFileKeyChange, type AssignmentRef } from './assignmentContext';
import { GRADE_SYSTEM, buildGradePrompt, gradeKey, makeEstimate, readCached, rubricRows, textHash, type GradeEstimate, type RubricRow } from './gradeEstimate';

const KEY = 'kea.assistant.grades';
const load = (): Record<string, GradeEstimate> => {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') || {};
  } catch {
    return {};
  }
};

interface GradeStore {
  byKey: Record<string, GradeEstimate>;
  running: Record<string, string | undefined>;
  error: Record<string, string | undefined>;
}
export const useGrades = create<GradeStore>(() => ({ byKey: load(), running: {}, error: {} }));

function persist(byKey: Record<string, GradeEstimate>) {
  useGrades.setState({ byKey });
  try {
    // (An unsaved file's estimate lasts only while it's open.)
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(Object.entries(byKey).filter(([k]) => !k.startsWith('tab:')).slice(-300))));
  } catch {}
}

// A new file's estimate follows it when it's saved.
onFileKeyChange((from, to) => {
  const byKey = useGrades.getState().byKey;
  const moved = Object.entries(byKey).filter(([k]) => k.startsWith(`${from}|`));
  if (!moved.length) return;
  const next = { ...byKey };
  for (const [k, v] of moved) {
    next[`${to}${k.slice(from.length)}`] = v;
    if (from.startsWith('tab:')) delete next[k];
  }
  persist(next);
});

/** The last estimate for the file in `tabId` against its current assignment, or null. */
export function cachedGrade(tabId: string, ref: AssignmentRef | null = assignmentOf(tabId)): GradeEstimate | null {
  if (!ref) return null;
  const sig = assignmentSig(ref);
  return readCached(useGrades.getState().byKey[gradeKey(fileKey(tabId), sig)], sig);
}

/** What Kea knows about grading the linked assignment: its rubric rows (from the scan), or pasted rubric text, and its instructions. */
export async function gradingInfo(ref: AssignmentRef): Promise<{ rows: RubricRow[]; rubricText?: string; instructions: string; title: string }> {
  if ('pasted' in ref) return { rows: [], rubricText: ref.pasted, instructions: ref.pasted, title: ref.label };
  const [guides, brief] = await Promise.all([api.scholar.guides().catch(() => ({}) as Record<string, any>), api.scholar.assignmentBrief(ref.id).catch(() => null)]);
  return { rows: rubricRows((guides as any)[ref.id]), instructions: brief?.text || '', title: ref.label };
}
export const hasRubric = (g: { rows: RubricRow[]; rubricText?: string }) => g.rows.length > 0 || !!g.rubricText?.trim();

/** Whether the person's Claude is connected (the plan signed in, or an API key saved). */
export async function claudeReady(): Promise<boolean> {
  try {
    if (setting('assistant.provider') === 'api') return !!(await api.assistant.status()).hasKey;
    const p = await api.assistant.planStatus();
    return p.installed && p.loggedIn;
  } catch {
    return false;
  }
}

/** One question to Claude, with no tools, on the person's own route. Returns Claude's text. */
async function askOnce(tabId: string, system: string, prompt: string, reqId: string): Promise<string> {
  const model = String(setting('assistant.gradeModel') || setting('assistant.model') || 'claude-opus-5-5');
  const effort = String(setting('assistant.gradeEffort') || 'low');
  if (setting('assistant.provider') === 'api') {
    const r = await api.assistant.send(reqId, { model, effort, system, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }], tools: [] });
    if (r.error) throw new Error(r.error);
    if (r.stopped) throw new Error('Stopped.');
    return (r.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
  }
  let text = '';
  let final = '';
  const off = api.assistant.onPlanEvent(({ id, ev }) => {
    if (id !== reqId) return;
    if (ev.type === 'assistant') for (const b of ev.message?.content || []) if (b.type === 'text' && b.text) text += `${b.text}\n`;
    if (ev.type === 'result' && typeof ev.result === 'string') final = ev.result;
  });
  try {
    // (Pinned to no open tab: the file's editing tools can't be reached from this question, so it only reads.)
    const r = await api.assistant.planSend(reqId, { tabId: `grade:${tabId}`, content: [{ type: 'text', text: prompt }], model, effort, system, web: false });
    if (r.error) throw new Error(r.error);
    if (r.stopped) throw new Error('Stopped.');
  } finally {
    off();
  }
  return final || text;
}

const reqs = new Map<string, string>();

/**
 * Estimate the grade of the file in `tabId` now: against the rubric, or (`rough`) from the instructions. The result
 * is kept with the file and the assignment. Never edits the file.
 */
export async function estimateGrade(tabId: string, opts: { rough?: boolean } = {}): Promise<GradeEstimate | null> {
  const ref = assignmentOf(tabId);
  const hooks = editorRegistry.get(tabId)?.ai;
  if (!ref || !hooks) return null;
  const key = gradeKey(fileKey(tabId), assignmentSig(ref));
  if (useGrades.getState().running[key]) return null;
  const reqId = uid();
  reqs.set(key, reqId);
  const set = (p: Partial<GradeStore>) => useGrades.setState(p);
  set({ running: { ...useGrades.getState().running, [key]: reqId }, error: { ...useGrades.getState().error, [key]: undefined } });
  try {
    const info = await gradingInfo(ref);
    const rough = !!opts.rough || !hasRubric(info);
    const doc = await hooks.getDocument();
    const text = doc.sections.length > 1 ? doc.sections.map((s) => `${s.label}:\n${s.text}`).join('\n\n') : doc.full;
    const prompt = buildGradePrompt({ title: info.title, noun: hooks.noun, mode: rough ? 'instructions' : 'rubric', rows: info.rows, rubricText: info.rubricText, instructions: info.instructions, text });
    const answer = await askOnce(tabId, GRADE_SYSTEM, prompt, reqId);
    if (reqs.get(key) !== reqId) return null;
    const est = makeEstimate({ answer, rows: info.rows, rough, docText: doc.full, assignment: assignmentSig(ref), model: String(setting('assistant.gradeModel') || setting('assistant.model') || '') });
    if (!est) throw new Error('Claude’s answer couldn’t be read. Try Refresh again.');
    persist({ ...useGrades.getState().byKey, [key]: est });
    return est;
  } catch (err: any) {
    if (reqs.get(key) === reqId) set({ error: { ...useGrades.getState().error, [key]: String(err?.message || err) } });
    return null;
  } finally {
    if (reqs.get(key) === reqId) {
      reqs.delete(key);
      set({ running: { ...useGrades.getState().running, [key]: undefined } });
    }
  }
}

/** Stop a running estimate. */
export function stopGrade(tabId: string) {
  const ref = assignmentOf(tabId);
  if (!ref) return;
  const key = gradeKey(fileKey(tabId), assignmentSig(ref));
  const id = useGrades.getState().running[key];
  if (!id) return;
  reqs.delete(key);
  setting('assistant.provider') === 'api' ? api.assistant.stop(id) : api.assistant.planStop(id);
  useGrades.setState({ running: { ...useGrades.getState().running, [key]: undefined } });
}

/** The file's text now, hashed like the cached estimate's (to say whether it changed since). */
export async function currentHash(tabId: string): Promise<string | null> {
  const d = await editorRegistry.get(tabId)?.ai?.getDocument().catch(() => null);
  return d ? textHash(d.full) : null;
}
