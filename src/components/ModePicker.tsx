import { useEffect, useState } from 'react';
import { Briefcase, Check, GraduationCap, Heart } from 'lucide-react';
import { KeaMode, keaModes, setModes, useKeaModes, workAvailable } from '../lib/modes';
import { useHubStatus } from './scholar/HubAccount';
import { useSetupDone } from '../lib/areas';
import { toast } from '../store';

const CHOICES: { id: KeaMode; label: string; blurb: string; icon: JSX.Element }[] = [
  { id: 'personal', label: 'Personal', blurb: 'Study on your own: notes and practice for things you learn. No school account.', icon: <Heart size={22} /> },
  { id: 'school', label: 'School', blurb: 'Connects to your school’s class site, plus classes you join with a code.', icon: <GraduationCap size={22} /> },
  { id: 'work', label: 'Work', blurb: 'Join your organization with a code. Its classes, trainings and shifts show up in Kea.', icon: <Briefcase size={22} /> },
];
// (Work only where this copy of Kea has the Work area.)
const shown = () => CHOICES.filter((c) => c.id !== 'work' || workAvailable);

/** The choices as cards, any mix. `onChange` gets the new picks. */
export function ModeChoices({ value, onChange }: { value: Record<KeaMode, boolean>; onChange(v: Record<KeaMode, boolean>): void }) {
  return (
    <div className="welcome-grid modes-grid" role="group" aria-label="How you use Kea">
      {shown().map((c) => {
        const on = value[c.id];
        return (
          <button key={c.id} className={`welcome-card ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => onChange({ ...value, [c.id]: !on })}>
            <span className="welcome-icon">{c.icon}</span>
            <span className="welcome-text">
              <strong>{c.label}</strong>
              <span>{c.blurb}</span>
            </span>
            <span className="welcome-check">{on && <Check size={16} />}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Settings → Kea account: the same choices, saved as they're ticked. */
export function ModeSettings() {
  const m = useKeaModes();
  const value = { personal: m.personal, school: m.school, work: m.work };
  return (
    <ModeChoices
      value={value}
      onChange={async (v) => {
        // (None is fine: Kea is then just documents, spreadsheets, slides and PDFs.)
        await setModes(v);
      }}
    />
  );
}

/** Right after the first Kea account sign-in: "How do you use Kea?". Shown once; Settings changes it later. */
export function ModePickerGate() {
  const status = useHubStatus();
  const modes = useKeaModes();
  const [pick, setPick] = useState<Record<KeaMode, boolean> | null>(null);
  const [busy, setBusy] = useState(false);
  // (On a new computer the first-run screen asks the same question: never both at once.)
  const setupDone = useSetupDone();
  const show = setupDone && !!status?.signedIn && !!status.me && !status.me.terms.needsAgreement && !modes.asked;
  useEffect(() => {
    if (show && !pick) {
      const m = keaModes();
      setPick({ personal: m.personal, school: m.school, work: m.work });
    }
  }, [show]);
  if (!show || !pick) return null;
  return (
    <div className="scrim">
      <div className="dialog modes-dialog" role="dialog" aria-label="How do you use Kea?">
        <h2>How do you use Kea?</h2>
        <p>Pick any that apply, or none for just documents. You can change this any time in Settings → Kea account.</p>
        <ModeChoices value={pick} onChange={setPick} />
        <div className="dialog-actions">
          <button
            className="btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await setModes(pick).catch((e) => toast(String(e.message || e), 'error'));
              setBusy(false);
            }}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
