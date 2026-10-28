import { useSettings, setting } from './settings';
import { api } from './api';

/**
 * The parts of Kea a person can use: documents and school. Only the areas that are on get a
 * title-bar button, Home sections and menu items. School keeps its old setting key
 * (scholar.enabled) so existing installs keep working. (Staffing, time clock and payroll are a
 * separate app, KeaS.)
 */

export type AreaId = 'documents' | 'school';

export interface AreaInfo {
  id: AreaId;
  label: string;
  /** One line for the first-run screen. */
  blurb: string;
  /** lucide icon name, resolved by the components that draw it. */
  icon: 'FileText' | 'GraduationCap';
  settingKey: string;
}

export const AREAS: AreaInfo[] = [
  { id: 'documents', label: 'Documents', blurb: 'Docs, spreadsheets, slides, PDFs, photos and video, plus your files and drives.', icon: 'FileText', settingKey: 'areas.documents' },
  { id: 'school', label: 'School', blurb: 'Your classes, calendar, readings and practice questions.', icon: 'GraduationCap', settingKey: 'scholar.enabled' },
];

export const areaInfo = (id: AreaId) => AREAS.find((a) => a.id === id)!;

function isOn(values: Record<string, any>, id: AreaId) {
  return values[areaInfo(id).settingKey] !== false;
}

/** The areas that are on, in display order. */
export function useAreas(): AreaId[] {
  return useSettings((s) => AREAS.filter((a) => isOn(s.values, a.id)).map((a) => a.id).join(',')).split(',').filter(Boolean) as AreaId[];
}

export const areaOn = (id: AreaId) => isOn(useSettings.getState().values, id);
export const useAreaOn = (id: AreaId) => useSettings((s) => isOn(s.values, id));

/** Turn areas on or off (the first-run screen and Settings). */
export function setAreas(on: Partial<Record<AreaId, boolean>>) {
  const patch: Record<string, any> = {};
  for (const [id, v] of Object.entries(on)) patch[areaInfo(id as AreaId).settingKey] = v;
  useSettings.getState().set(patch);
}

/** Something the person just started using (for example adding a class) turns its area on. */
export function noteUsing(id: AreaId) {
  if (setting('areas.auto') === false || areaOn(id)) return;
  setAreas({ [id]: true });
}

export const useSetupDone = () => useSettings((s) => s.loaded && s.values['areas.setupDone'] === true);

/**
 * People who used Kea before areas existed shouldn't be asked what they use it for: if they have
 * classes or saved settings, keep what they had and skip the first-run screen.
 */
let inferring: Promise<boolean> | null = null;
export function inferSetup(): Promise<boolean> {
  // One check at a time (React runs effects twice in development).
  return (inferring ??= runInfer().finally(() => (inferring = null)));
}
async function runInfer(): Promise<boolean> {
  const s = useSettings.getState();
  if (!s.loaded || s.values['areas.setupDone'] === true) return true;
  let hasClasses = false;
  let hasFiles = false;
  try {
    hasClasses = (await api.scholar.status()).hasData;
  } catch {
    // Scholar isn't available (for example in a build without it).
  }
  try {
    hasFiles = (await api.getRecent()).length > 0;
  } catch {
    // No recent list yet.
  }
  if (!hasClasses && !hasFiles) return false;
  // The person may have answered the first-run question while this was checking: their answer wins.
  if (useSettings.getState().values['areas.setupDone'] === true) return true;
  // Keep what they had: documents stay on, school stays on only if they have classes or never turned it off.
  useSettings.getState().set({ 'areas.setupDone': true, 'scholar.enabled': hasClasses || s.values['scholar.enabled'] !== false });
  return true;
}

/**
 * Turn School on when classes first appear (added here, or synced from another device). Someone who
 * already had classes and turned School off keeps it off. Returns an unsubscribe.
 */
export function watchSchool(): () => void {
  let had: boolean | null = null;
  const check = () =>
    api.scholar
      .status()
      .then((st) => {
        if (had === false && st.hasData) noteUsing('school');
        had = st.hasData;
      })
      .catch(() => {});
  check();
  return api.scholar.onChanged(check);
}
