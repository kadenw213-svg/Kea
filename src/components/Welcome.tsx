import { useEffect, useState } from 'react';
import { Briefcase, Check, FileText, GraduationCap, Wallet } from 'lucide-react';
import { Logo } from './Logo';
import { AREAS, AreaId, inferSetup, setAreas } from '../lib/areas';
import { useSettings } from '../lib/settings';

const ICONS = { FileText, GraduationCap, Briefcase, Wallet };

/**
 * First run: "What will you use Kea for?". Any mix of areas; the ones left off stay out of the
 * title bar, Home and menus until they're turned on (by hand or by starting to use them).
 */
export function Welcome() {
  const loaded = useSettings((s) => s.loaded);
  const [checking, setChecking] = useState(true);
  const [picked, setPicked] = useState<Record<AreaId, boolean>>({ documents: true, school: false, work: false, payroll: false });

  useEffect(() => {
    if (!loaded) return;
    // People who used Kea before this screen existed skip it.
    inferSetup().then((done) => !done && setChecking(false));
  }, [loaded]);

  if (!loaded || checking) return <div className="center-fill" />;

  const toggle = (id: AreaId) =>
    setPicked((p) => {
      const next = { ...p, [id]: !p[id] };
      if (id === 'payroll' && next.payroll) next.work = true;
      if (id === 'work' && !next.work) next.payroll = false;
      return next;
    });
  const any = Object.values(picked).some(Boolean);
  const start = () => {
    setAreas(picked);
    useSettings.getState().set({ 'areas.setupDone': true });
  };

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <Logo size={40} />
        <h1>What will you use Kea for?</h1>
        <p className="welcome-sub">Pick any that apply. You can change this later in Settings, and parts turn on by themselves when you join a class or a workplace.</p>
        <div className="welcome-grid" role="group" aria-label="Areas of Kea">
          {AREAS.map((a) => {
            const Icon = ICONS[a.icon];
            const on = picked[a.id];
            return (
              <button key={a.id} className={`welcome-card ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => toggle(a.id)}>
                <span className="welcome-icon">
                  <Icon size={22} />
                </span>
                <span className="welcome-text">
                  <strong>{a.label}</strong>
                  <span>{a.blurb}</span>
                </span>
                <span className="welcome-check">{on && <Check size={16} />}</span>
              </button>
            );
          })}
        </div>
        <button className="btn primary welcome-go" disabled={!any} onClick={start}>
          Start using Kea
        </button>
      </div>
    </div>
  );
}
