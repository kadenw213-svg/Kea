// "How do you use Kea?": Personal, School and Work, any mix. Asked after the first Kea account sign-in and changed
// in Settings → Kea account.
//
// - Personal: your own study tools, offline.
// - School: Scholar's class-site scans and Kea classes.
// - Work: the Work area (an organization's classes, shifts and calendar), when this copy of Kea has it.
//
// The answers only turn parts of Kea on or off. Everything lives on one calendar and one class list (every class site,
// Kea classes, study and Work together); nothing is hidden or split by them. Personal and School both live in
// Scholar, so either one keeps School (scholar.enabled) on.
import { useSettings } from './settings';
import { useTabs } from '../store';

export type KeaMode = 'personal' | 'school' | 'work';
export interface KeaModes {
  personal: boolean;
  school: boolean;
  work: boolean;
  /** The person has answered "How do you use Kea?". */
  asked: boolean;
}

/** Before anyone answers, Kea behaves as it always has: School on unless it was turned off. */
function modesFrom(v: Record<string, any>): KeaModes {
  const asked = v['modes.asked'] === true;
  return {
    personal: v['modes.personal'] === true,
    school: asked ? v['modes.school'] === true : v['scholar.enabled'] !== false,
    work: v['modes.work'] === true,
    asked,
  };
}

export function useKeaModes(): KeaModes {
  const key = useSettings((s) => JSON.stringify(modesFrom(s.values)));
  return JSON.parse(key);
}
export const keaModes = () => modesFrom(useSettings.getState().values);

/** Save the answer. (It turns parts of Kea on or off; it never moves or hides anyone's classes.) */
export async function setModes(m: { personal: boolean; school: boolean; work: boolean }) {
  useSettings.getState().set({ 'modes.personal': m.personal, 'modes.school': m.school, 'modes.work': m.work, 'modes.asked': true, 'scholar.enabled': m.personal || m.school });
}

// ---------- Work ----------
// The Work area's screen is its own module (components/work/WorkScreen.tsx). Found at build time, so a copy of Kea
// without it simply has no Work button.
const workModules = import.meta.glob('../components/work/WorkScreen.tsx');
export const workAvailable = Object.keys(workModules).length > 0;
export const loadWorkScreen = () => {
  const load = Object.values(workModules)[0];
  return load ? (load() as Promise<{ WorkScreen: () => JSX.Element }>) : Promise.reject(new Error('Work is not in this copy of Kea.'));
};

export function openWork() {
  const tabs = useTabs.getState();
  const existing = tabs.tabs.find((t) => t.kind === 'work');
  if (existing) tabs.setActive(existing.id);
  else tabs.addTab({ kind: 'work', name: 'Work', path: null, data: null });
}
