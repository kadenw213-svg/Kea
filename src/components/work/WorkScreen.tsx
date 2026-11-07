// Kea's Work mode: organizations on the Kea Hub. The to-do box sits on top; below it, the chosen organization:
// schedule, availability and certs for everyone, and forms, scheduling, people, training, structure, budgets and
// settings for those who run it.
import { useEffect, useState } from 'react';
import { Building2, Clock3, KeyRound, Plus } from 'lucide-react';
import { ask, toast } from '../../store';
import { refreshHub, useHubStatus } from '../scholar/HubAccount';
import { VerifyEmail } from '../scholar/Account';
import { accountOf } from '../account/hubStore';
import { localTz, post, useMyId, useWork, Tab } from './workStore';
import { RANK } from './types';
import type { Org } from './types';
import { Card, Empty, Field, Loading } from './ui';
import { TodoBox } from './TodoBox';
import { AvailabilityTab } from './Availability';
import { MySchedule } from './MySchedule';
import { MyCerts, Training } from './Certs';
import { FormsTab } from './Forms';
import { SchedulingTab } from './ScheduleBuilder';
import { BudgetsTab, OrgInfo, PeopleTab, SettingsTab, StructureTab, refreshOrgs } from './OrgAdmin';
import './work.css';

const TABS: { id: Tab; label: string; min: keyof typeof RANK }[] = [
  { id: 'schedule', label: 'My schedule', min: 'member' },
  { id: 'availability', label: 'Availability', min: 'member' },
  { id: 'certs', label: 'Certs and classes', min: 'member' },
  { id: 'org', label: 'Organization', min: 'member' },
  { id: 'forms', label: 'Forms', min: 'manager' },
  { id: 'scheduling', label: 'Scheduling', min: 'manager' },
  { id: 'people', label: 'People', min: 'manager' },
  { id: 'training', label: 'Training', min: 'manager' },
  { id: 'structure', label: 'Structure', min: 'admin' },
  { id: 'budgets', label: 'Budgets', min: 'manager' },
  { id: 'settings', label: 'Settings', min: 'admin' }
];

export function WorkScreen() {
  const status = useHubStatus();
  const orgs = useWork((s) => s.orgs);
  const orgId = useWork((s) => s.orgId);
  const tab = useWork((s) => s.tab);
  const go = useWork((s) => s.go);
  const [adding, setAdding] = useState<'join' | 'create' | null>(null);
  const me = accountOf(status);
  useEffect(() => {
    if (!status) refreshHub();
  }, []);
  // (A different account, or signed out: what the last one had open goes.)
  useEffect(() => {
    setAdding(null);
    if (status?.signedIn) refreshOrgs();
  }, [status?.signedIn, me?.id]);

  if (!status) return <Loading />;
  if (!status.signedIn)
    return (
      <div className="work">
        <div className="work-inner wk-narrow">
          <h1 className="work-title">Work</h1>
          {/* (Kea's sign-in screen covers this while signed out: one place to sign in.) */}
          <p className="muted">Sign in with your Kea account to see your organizations: schedules, availability, certs and classes.</p>
        </div>
      </div>
    );
  const org = orgs?.find((o) => o.id === orgId) ?? null;
  const tabs = org && org.memberStatus === 'active' ? TABS.filter((t) => RANK[org.role] >= RANK[t.min]) : [];
  const current = tabs.some((t) => t.id === tab) ? tab : tabs[0]?.id ?? 'schedule';
  const verified = !!me?.emailVerified;
  const hasOrgs = !!orgs?.length;

  return (
    <div className="work">
      <div className="work-inner">
        <header className="work-head">
          <h1 className="work-title">Work</h1>
          <div className="work-orgs">
            {(orgs ?? []).map((o) => (
              <button key={o.id} className={`wk-chip ${o.id === orgId ? 'on' : ''}`} onClick={() => go(o.id)}>
                {o.name}
                {o.memberStatus === 'pending' || o.status !== 'active' ? <Clock3 size={12} /> : null}
              </button>
            ))}
          </div>
          <span className="wk-spacer" />
          {/* (With no organization yet, the empty state below has these.) */}
          {hasOrgs && (
            <>
              <button className="btn sm" onClick={() => setAdding(adding === 'join' ? null : 'join')}>
                <KeyRound size={14} /> Join with a code
              </button>
              <button className="btn sm" onClick={() => setAdding(adding === 'create' ? null : 'create')}>
                <Plus size={14} /> New organization
              </button>
            </>
          )}
        </header>
        {adding === 'join' && <JoinOrg onDone={() => setAdding(null)} verified={verified} />}
        {adding === 'create' && <CreateOrg onDone={() => setAdding(null)} verified={verified} />}

        {hasOrgs && <TodoBox orgId={orgId} />}

        {!orgs ? (
          <Loading />
        ) : !orgs.length ? (
          adding ? null : (
            <Empty title="You’re not in an organization yet">
              <p className="muted">Ask your manager for a join code, or set up your own organization.</p>
              {!verified && (
                <div className="wk-verify">
                  <p>
                    <b>First, verify your email.</b> Joining or making an organization needs a verified email, so your manager knows it’s really you.
                  </p>
                  <VerifyEmail compact />
                </div>
              )}
              <div className="wk-actions center">
                <button className="btn primary" onClick={() => setAdding('join')}>
                  <KeyRound size={15} /> Join with a code
                </button>
                <button className="btn" onClick={() => setAdding('create')}>
                  <Building2 size={15} /> New organization
                </button>
              </div>
            </Empty>
          )
        ) : org ? (
          <OrgBody org={org} tabs={tabs} current={current} />
        ) : null}
      </div>
    </div>
  );
}

function OrgBody({ org, tabs, current }: { org: Org; tabs: typeof TABS; current: Tab }) {
  const go = useWork((s) => s.go);
  const me = useMyId();
  if (org.memberStatus === 'pending')
    return (
      <Card title={org.name}>
        <p>Your request to join is waiting for a manager to approve it.</p>
        <div className="wk-actions">
          <LeaveButton org={org} label="Cancel request" />
        </div>
      </Card>
    );
  if (org.status === 'suspended')
    return (
      <Card title={org.name}>
        <p>This organization is suspended on the Kea Hub. Contact its owner.</p>
        <div className="wk-actions">
          <LeaveButton org={org} />
        </div>
      </Card>
    );
  return (
    <>
      {org.status === 'pending' && <p className="af-info">{org.name} is waiting for approval on the Kea Hub. You can set it up now; join codes start working once it’s approved.</p>}
      <nav className="work-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={current === t.id ? 'on' : ''} onClick={() => go(org.id, t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <div className="work-body">
        {current === 'schedule' && <MySchedule org={org} />}
        {current === 'availability' && <AvailabilityTab org={org} />}
        {current === 'certs' && <MyCerts org={org} me={me} />}
        {current === 'org' && <OrgInfo org={org} />}
        {current === 'forms' && <FormsTab org={org} />}
        {current === 'scheduling' && <SchedulingTab org={org} />}
        {current === 'people' && <PeopleTab org={org} />}
        {current === 'training' && <Training org={org} />}
        {current === 'structure' && <StructureTab org={org} />}
        {current === 'budgets' && <BudgetsTab org={org} />}
        {current === 'settings' && org.settings && <SettingsTab key={org.id} org={org} />}
      </div>
    </>
  );
}

function LeaveButton({ org, label = 'Leave' }: { org: Org; label?: string }) {
  const pending = org.memberStatus === 'pending';
  return (
    <button
      className="btn danger"
      onClick={async () => {
        if ((await ask(pending ? `Cancel your request to join ${org.name}?` : `Leave ${org.name}?`, pending ? 'You’d need the join code again to ask later.' : 'Your upcoming shifts open up again, and you’ll need a new code to come back.', [{ id: 'no', label: 'Keep it' }, { id: 'yes', label, danger: true, primary: true }])) !== 'yes') return;
        try {
          await post(`/v1/orgs/${org.id}/leave`);
          await refreshOrgs();
          useWork.getState().go(useWork.getState().orgs?.[0]?.id ?? null);
        } catch (e: any) {
          toast(e.message, 'error');
        }
      }}
    >
      {label}
    </button>
  );
}

/** The Hub's "verify first" answer names a place that isn't in Kea; say where it is. */
const VERIFY_FIRST = /^Verify your email first/;
const verifyText = (what: string) => `Verify your email first (Settings → Kea account → Verify with Google), then ${what}.`;

function JoinOrg({ onDone, verified }: { onDone(): void; verified: boolean }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = code.replace(/[^A-Za-z0-9]/g, '').length >= 10;
  const join = async () => {
    setBusy(true);
    try {
      const r = await post<{ org: Org; alreadyMember: boolean; pending?: boolean }>('/v1/orgs/join', { code });
      toast(r.alreadyMember ? `You’re already in ${r.org.name}.` : r.pending ? `Asked to join ${r.org.name}. A manager will approve it.` : `Welcome to ${r.org.name}.`);
      await refreshOrgs();
      useWork.getState().go(r.org.id, 'schedule');
      onDone();
    } catch (e: any) {
      toast(VERIFY_FIRST.test(e.message) ? verifyText('join the organization') : e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Join an organization" className="wk-narrow">
      {!verified && (
        <div className="wk-verify">
          <p>
            <b>1. Verify your email.</b> Joining needs a verified email, so your manager knows it’s really you.
          </p>
          <VerifyEmail compact />
          <p>
            <b>2. Enter your code.</b>
          </p>
        </div>
      )}
      <Field label="Join code" hint="From your manager. Dashes and spaces don’t matter.">
        <input className="input wk-codein" autoFocus value={code} placeholder="ABCD-EFGH-JKMN" onChange={(e) => setCode(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === 'Enter' && ready && verified && join()} />
      </Field>
      <div className="wk-actions">
        <button className="btn" onClick={onDone}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !ready || !verified} title={!verified ? 'Verify your email first' : !ready ? 'Enter the whole code (10 letters and numbers)' : undefined} onClick={join}>
          Join
        </button>
      </div>
    </Card>
  );
}

function CreateOrg({ onDone, verified }: { onDone(): void; verified: boolean }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('nonprofit');
  const [tz, setTz] = useState(localTz());
  const [state, setState] = useState('');
  const [busy, setBusy] = useState(false);
  const make = async () => {
    setBusy(true);
    try {
      const r = await post<{ org: Org }>('/v1/orgs', { name, kind, tz, state: state || null });
      toast(r.org.status === 'pending' ? `${r.org.name} is made. It’s waiting for approval on the Kea Hub; you can set it up meanwhile.` : `${r.org.name} is ready.`);
      await refreshOrgs();
      useWork.getState().go(r.org.id, 'structure');
      onDone();
    } catch (e: any) {
      toast(VERIFY_FIRST.test(e.message) ? verifyText('make the organization') : e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="New organization" className="wk-narrow">
      {!verified && (
        <div className="wk-verify">
          <p>Making an organization needs a verified email first.</p>
          <VerifyEmail compact />
        </div>
      )}
      <div className="wk-form-grid">
        <Field label="Name">
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="For example Westside Pool" />
        </Field>
        <Field label="Kind">
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="nonprofit">Nonprofit</option>
            <option value="government">Government</option>
            <option value="private">Business</option>
            <option value="school">School</option>
            <option value="other">Other</option>
          </select>
        </Field>
        <Field label="Time zone">
          <input className="input" value={tz} onChange={(e) => setTz(e.target.value)} />
        </Field>
        <Field label="State" hint="Two letters, for the labor rules.">
          <input className="input" value={state} maxLength={2} onChange={(e) => setState(e.target.value.toUpperCase())} placeholder="CO" />
        </Field>
      </div>
      <p className="muted af-small">Payroll details (SSNs, bank accounts, pay runs) never go to the Kea Hub. They stay in KeaS on your payroll admin’s PC.</p>
      <div className="wk-actions">
        <button className="btn" onClick={onDone}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || name.trim().length < 2 || !verified} title={!verified ? 'Verify your email first' : name.trim().length < 2 ? 'Give it a name' : undefined} onClick={make}>
          Make organization
        </button>
      </div>
    </Card>
  );
}

export default WorkScreen;
