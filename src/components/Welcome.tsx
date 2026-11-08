import { useEffect, useState } from 'react';
import { Logo } from './Logo';
import { inferSetup, setAreas } from '../lib/areas';
import { useSettings } from '../lib/settings';
import { KeaMode, setModes } from '../lib/modes';
import { ModeChoices } from './ModePicker';
import { toast } from '../store';
import { SyncPicker } from './settings/SyncPicker';

/**
 * First run: "How do you use Kea?", the same choices as after signing in to a Kea account (Personal, School, Work), so
 * a new person is asked once. Documents, spreadsheets and slides are always there; School's areas stay out of the
 * title bar, Home and menus until a mode that uses them is on.
 */
export function Welcome() {
  const loaded = useSettings((s) => s.loaded);
  const [checking, setChecking] = useState(true);
  // Nothing is ticked for the person: leaving all of them off is "just documents".
  const [picked, setPicked] = useState<Record<KeaMode, boolean>>({ personal: false, school: false, work: false });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!loaded) return;
    // People who used Kea before this screen existed skip it.
    inferSetup().then((done) => !done && setChecking(false));
  }, [loaded]);

  if (!loaded || checking) return <div className="center-fill" />;

  const any = picked.personal || picked.school || picked.work;
  const start = async () => {
    setBusy(true);
    try {
      setAreas({ documents: true, school: picked.personal || picked.school });
      await setModes(picked);
      useSettings.getState().set({ 'areas.setupDone': true });
    } catch (e: any) {
      toast(String(e?.message || e), 'error');
    }
    setBusy(false);
  };

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <Logo size={40} />
        <h1>How do you use Kea?</h1>
        <p className="welcome-sub">Documents, spreadsheets, slides and PDFs are always here. Add any of these, or none. You can change it later in Settings.</p>
        <ModeChoices value={picked} onChange={setPicked} />
        <div className="welcome-sync">
          <h2>Where your things sync</h2>
          <p className="welcome-sub">Your classes, Kea cloud documents and your phone’s files go here. Kea cloud needs your Kea account online; you can change this any time.</p>
          <SyncPicker compact />
        </div>
        <button className="btn primary welcome-go" disabled={busy} onClick={start}>
          {any ? 'Start using Kea' : 'Just documents'}
        </button>
      </div>
    </div>
  );
}
