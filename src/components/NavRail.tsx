// The navigation rail (Kea 0.100, like Windows 11's NavigationView in Outlook, Teams and Photos): Kea's places down
// the left, open files as tabs on top. Home, Calendar (the one calendar: classes, shifts, personal events), School,
// Work and the owner's audit, then Notifications, Settings and the account at the bottom. Places are the Home,
// School (scholar) and Work tabs underneath; the tab strip no longer shows them.
import { useEffect, useState } from 'react';
import { Home, CalendarDays, GraduationCap, Briefcase, Radar, Bell, Settings as SettingsIcon, MessageSquareWarning } from 'lucide-react';
import { noteAction, snapshotActivity } from '../lib/activity';
import { useTabs } from '../store';
import { useAreas, useSetupDone } from '../lib/areas';
import { openAudit, openWork, useAuditOn, useKeaModes, workAvailable } from '../lib/modes';
import { openScholar, useScholar } from './scholar/scholarStore';
import { openSettings } from '../lib/settings';
import { api } from '../lib/api';
import { AccountButton } from './account/AccountButton';

export type Place = 'home' | 'calendar' | 'school' | 'work' | 'audit' | 'notifications';

/** Which place is showing (null: a file). */
export function usePlace(): Place | null {
  const kind = useTabs((s) => s.tabs.find((t) => t.id === s.activeId)?.kind);
  const view = useScholar((s) => s.view.name);
  // (Studying is School, whichever view it was opened from.)
  const studying = useScholar((s) => !!s.study);
  if (kind === 'home') return 'home';
  if (kind === 'work') return 'work';
  if (kind === 'audit') return 'audit';
  if (kind === 'scholar') return studying ? 'school' : view === 'calendar' ? 'calendar' : view === 'inbox' ? 'notifications' : 'school';
  return null;
}

/** Go to a place (also from the shortcuts and the command palette). */
export function goPlace(p: Place) {
  noteAction(`went to ${p}`);
  if (p === 'home') return useTabs.getState().setActive('home');
  if (p === 'calendar') return openScholar({ name: 'calendar' });
  if (p === 'notifications') return openScholar({ name: 'inbox' });
  if (p === 'school') return openScholar({ name: 'school' });
  if (p === 'work') return openWork();
  if (p === 'audit') return openAudit();
}

/** Unread notifications, kept current (for the bell's badge). */
function useUnread() {
  const tick = useScholar((s) => s.inboxTick + s.version * 1000);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    const read = () =>
      api.scholar
        .inbox()
        .then((list) => live && setN(list.filter((x) => !x.read).length))
        .catch(() => {});
    read();
    const off = api.scholar.onNews(read);
    return () => {
      live = false;
      off();
    };
  }, [tick]);
  return n;
}

export function NavRail() {
  const setupDone = useSetupDone();
  const areas = useAreas();
  const modes = useKeaModes();
  const auditOn = useAuditOn();
  const place = usePlace();
  const unread = useUnread();
  if (!setupDone) return null;
  const school = areas.includes('school');
  const work = modes.work && workAvailable;
  const items: { p: Place; label: string; Icon: typeof Home; title: string; show: boolean }[] = [
    { p: 'home', label: 'Home', Icon: Home, title: 'Home (Ctrl+1)', show: true },
    { p: 'calendar', label: 'Calendar', Icon: CalendarDays, title: 'Calendar: classes, shifts and your own events (Ctrl+2)', show: true },
    { p: 'school', label: 'School', Icon: GraduationCap, title: 'School: your classes, study and messages (Ctrl+3)', show: school },
    { p: 'work', label: 'Work', Icon: Briefcase, title: 'Work: your organizations, schedule and availability (Ctrl+4)', show: work },
    { p: 'audit', label: 'Audit', Icon: Radar, title: 'Product audit (owner tool)', show: auditOn }
  ];
  return (
    <nav className="rail" aria-label="Kea">
      {items
        .filter((i) => i.show)
        .map(({ p, label, Icon, title }) => (
          <button key={p} className={`rail-item ${place === p ? 'on' : ''}`} title={title} aria-current={place === p ? 'page' : undefined} onClick={() => goPlace(p)}>
            <Icon size={20} strokeWidth={place === p ? 2.1 : 1.7} />
            <span className="rail-label">{label}</span>
          </button>
        ))}
      <span className="rail-fill" />
      <button className={`rail-item ${place === 'notifications' ? 'on' : ''}`} title="Notifications" aria-current={place === 'notifications' ? 'page' : undefined} onClick={() => goPlace('notifications')}>
        <Bell size={20} strokeWidth={place === 'notifications' ? 2.1 : 1.7} />
        {unread > 0 && <span className="rail-badge">{unread > 99 ? '99+' : unread}</span>}
        <span className="rail-label">Alerts</span>
      </button>
      <button
        className="rail-item rail-feedback"
        title="Report a bug or suggest something: it goes straight to Kea’s developer"
        onClick={() => {
          snapshotActivity();
          openSettings('feedback');
        }}
      >
        <MessageSquareWarning size={20} strokeWidth={1.7} />
        <span className="rail-label">Feedback</span>
      </button>
      <button className="rail-item" title="Settings (Ctrl+,)" onClick={() => openSettings()}>
        <SettingsIcon size={20} strokeWidth={1.7} />
        <span className="rail-label">Settings</span>
      </button>
      <AccountButton rail />
    </nav>
  );
}
