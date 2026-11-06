// "How do you use Kea?": Personal, School and Work, any mix. Asked after the first Kea account sign-in and changed
// in Settings → Kea account.
//
// - Personal: your own study tools, offline. Its classes live in a Scholar profile named "Personal", which shows no
//   Kea Hub classes.
// - School: Scholar as it is (class-site scans) plus Kea Hub classes, in the "School" profile.
// - Work: the Work area (an organization's classes, shifts and calendar), when this copy of Kea has it.
//
// Personal and School both live in Scholar, so either one keeps School (scholar.enabled) on.
import { useSettings } from './settings';
import { api, ProfileList } from './api';
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

/** A profile is a Personal one by its name or id ("Personal", "personal-2"). */
export const isPersonalProfile = (p: { id: string; name: string } | undefined | null) => !!p && (/^personal(-\d+)?$/.test(p.id) || /^personal\b/i.test(p.name));

/** Save the answer and line up Kea's profiles with it. */
export async function setModes(m: { personal: boolean; school: boolean; work: boolean }) {
  useSettings.getState().set({ 'modes.personal': m.personal, 'modes.school': m.school, 'modes.work': m.work, 'modes.asked': true, 'scholar.enabled': m.personal || m.school });
  if (!m.personal && !m.school) return;
  let p: ProfileList;
  try {
    p = await api.scholar.profiles();
  } catch {
    return; // (a build without Scholar)
  }
  const was = p.active;
  if (m.personal && !p.list.some(isPersonalProfile)) p = await api.scholar.createProfile('Personal');
  const personal = p.list.find(isPersonalProfile);
  const school = p.list.find((x) => !isPersonalProfile(x));
  // Stay where the person was unless that profile's mode is now off.
  const keep = p.list.find((x) => x.id === was);
  const want = keep && (isPersonalProfile(keep) ? m.personal : m.school) ? keep : m.school ? school : personal;
  if (want && want.id !== p.active) await api.scholar.selectProfile(want.id);
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
