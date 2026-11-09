// Kea's Work mode: organizations hosted on the Kea account server and on KeaS servers this account joined. The to-do
// box sits on top; below it, the chosen organization: schedule, time (with My pay), availability and certs for
// everyone, and forms, scheduling, people (with pay codes), training, structure, budgets and settings for those whose
// roles allow them (the abilities the server sends; on a KeaS 0.5 Hub, the fixed role's). Making an organization on
// the Kea account server is an application the owner approves (ApplyHosting); an organization can also run its own KeaS
// (made in the KeaS app).
import { useEffect, useState } from 'react';
import { Building2, Clock3, KeyRound, LogIn, Plus, ServerOff, Trash2 } from 'lucide-react';
import { api, JoinedServer } from '../../lib/api';
import { ask, toast } from '../../store';
import { refreshHub, useHubStatus } from '../scholar/HubAccount';
import { accountOf } from '../account/hubStore';
import { NeedsOnline } from '../account/NeedsOnline';
import { get, post, useMyId, useWork, Tab } from './workStore';
import { can, canAny } from './types';
import type { Org } from './types';
import { Advanced, Card, Empty, Field, Loading } from './ui';
import { FoldGroup } from '../Fold';
import { applicationLine, latestApplication } from './payRules';
import type { Application } from './payRules';
import { TimeTab } from './TimeClock';
import { TodoBox } from './TodoBox';
import { AvailabilityTab } from './Availability';
import { MySchedule } from './MySchedule';
import { MyCerts, Training } from './Certs';
import { FormsTab } from './Forms';
import { SchedulingTab } from './ScheduleBuilder';
import { BudgetsTab, OrgInfo, PeopleTab, SettingsTab, StructureTab, refreshOrgs } from './OrgAdmin';
import './work.css';

/** The tabs, each shown to those whose roles allow it. */
const TABS: { id: Tab; label: string; show(o: Org): boolean }[] = [
  { id: 'schedule', label: 'My schedule', show: () => true },
  { id: 'time', label: 'Time', show: (o) => canAny(o, ['clock.self', 'timecards.view', 'timecards.approve', 'timeoff.decide', 'timeoff.request']) && (!!o.abilities || o.server != null) },
  { id: 'availability', label: 'Availability', show: () => true },
  { id: 'certs', label: 'Certs and classes', show: () => true },
  { id: 'org', label: 'Organization', show: () => true },
  { id: 'forms', label: 'Forms', show: (o) => can(o, 'forms.manage') },
  { id: 'scheduling', label: 'Scheduling', show: (o) => canAny(o, ['schedule.edit', 'schedule.publish']) },
  { id: 'people', label: 'People', show: (o) => canAny(o, ['people.view', 'people.approve', 'people.edit', 'people.remove', 'codes.make', 'roles.assign', 'roles.manage', 'swaps.decide', 'paycodes.manage', 'paycodes.assign']) },
  { id: 'training', label: 'Training', show: (o) => canAny(o, ['certs.manage', 'classes.manage']) },
  { id: 'structure', label: 'Structure', show: (o) => can(o, 'structure.edit', null) },
  { id: 'budgets', label: 'Budgets', show: (o) => canAny(o, ['budgets.view', 'budgets.edit', 'budgets.costs']) },
  { id: 'settings', label: 'Settings', show: (o) => can(o, 'settings.edit', null) || can(o, 'policies.manage') }
];

export function WorkScreen() {
  const status = useHubStatus();
  const orgs = useWork((s) => s.orgs);
  const servers = useWork((s) => s.servers);
  const account = useWork((s) => s.account);
  const orgId = useWork((s) => s.orgId);
  const tab = useWork((s) => s.tab);
  const go = useWork((s) => s.go);
  const [adding, setAdding] = useState<'join' | 'create' | null>(null);
  const joinLink = useWork((s) => s.joinLink);
  useEffect(() => {
    if (joinLink) setAdding('join');
  }, [joinLink]);
  const me = accountOf(status);
  useEffect(() => {
    if (!status) refreshHub();
  }, []);
  // (A different account, or signed out: what the last one had open goes.)
  // (KeaS servers joined with a pass keep working while the account itself isn't online.)
  useEffect(() => {
    setAdding(null);
    api.servers.list().then((r) => {
      if (r.ok) useWork.setState({ servers: r.value });
      if (status?.signedIn || (r.ok && r.value.length)) refreshOrgs();
    });
    return api.servers.onChanged(() => refreshOrgs());
  }, [status?.signedIn, me?.id]);

  if (!status) return <Loading />;
  if (!status.signedIn && !servers.length)
    return (
      <div className="work">
        <div className="work-inner wk-narrow">
          <h1 className="work-title">Work</h1>
          <NeedsOnline what="Work shows your organizations: schedules, availability, certs and classes" />
        </div>
      </div>
    );
  const org = orgs?.find((o) => o.id === orgId) ?? null;
  const tabs = org && org.memberStatus === 'active' ? TABS.filter((t) => t.show(org)) : [];
  const several = new Set((orgs ?? []).map((o) => o.server?.id ?? '')).size > 1;
  const current = tabs.some((t) => t.id === tab) ? tab : tabs[0]?.id ?? 'schedule';
  const hasOrgs = !!orgs?.length;
  // (Making an organization is an application to the Kea account server; one on a KeaS server is made in the KeaS app.)
  const canCreate = status.signedIn && !!account?.hostedOrgs;

  return (
    <div className="work">
      <div className="work-inner">
        <header className="work-head">
          <h1 className="work-title">Work</h1>
          <div className="work-orgs">
            {(orgs ?? []).map((o) => (
              <button key={o.id} className={`wk-pick ${o.id === orgId ? 'on' : ''}`} title={o.server ? `On ${o.server.name || o.server.url}` : undefined} onClick={() => go(o.id)}>
                {o.name}
                {several && o.server && o.server.name !== o.name && <span className="wk-chip-server">{o.server.name}</span>}
                {o.memberStatus === 'pending' || o.status !== 'active' ? <Clock3 size={12} /> : null}
              </button>
            ))}
          </div>
          <span className="wk-spacer" />
          {/* (With no organization yet, the empty state below has these.) */}
          {hasOrgs && (
            <>
              <button className="btn sm" onClick={() => setAdding(adding === 'join' ? null : 'join')}>
                <KeyRound size={14} /> Join
              </button>
              {canCreate && (
                <button className="btn sm" onClick={() => setAdding(adding === 'create' ? null : 'create')}>
                  <Plus size={14} /> Create an organization
                </button>
              )}
            </>
          )}
        </header>
        <ServerNotes servers={servers} />
        {adding === 'join' && <JoinOrg onDone={() => setAdding(null)} />}
        {adding === 'create' && canCreate && <ApplyHosting onDone={() => setAdding(null)} />}

        {hasOrgs && <TodoBox orgId={orgId} />}

        {!orgs ? (
          <Loading />
        ) : !orgs.length ? (
          adding ? null : (
            <Empty title="You’re not in an organization yet">
              <p className="muted">Open the join link your organization gave you, or paste it here.</p>
              <div className="wk-actions center">
                <button className="btn primary" onClick={() => setAdding('join')}>
                  <KeyRound size={15} /> Join an organization
                </button>
                {canCreate && (
                  <button className="btn" onClick={() => setAdding('create')}>
                    <Building2 size={15} /> Create an organization
                  </button>
                )}
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
        <p>
          <Clock3 size={14} /> Request sent. Your manager approves it.
        </p>
        <div className="wk-actions">
          <LeaveButton org={org} label="Cancel request" />
        </div>
      </Card>
    );
  if (org.removed)
    return (
      <Card title={org.name}>
        <p>This organization isn’t on its server any more. Its owner may have removed it.</p>
      </Card>
    );
  if (org.status === 'suspended')
    return (
      <Card title={org.name}>
        <p>This organization is paused for now. Your account and everything else in Kea are fine. Ask its owner if you need to know more.</p>
      </Card>
    );
  return (
    <>
      {org.status === 'pending' && !org.server && <p className="af-info">{org.name} is waiting for approval. You can set it up now; join codes start working once it’s approved.</p>}
      <nav className="work-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={current === t.id ? 'on' : ''} onClick={() => go(org.id, t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      {/* (Each tab's cards fold: the first open, the rest closed until opened, each remembered.) */}
      <FoldGroup key={`${org.id}:${current}`} screen={`work:${current}`}>
      <div className="work-body">
        {current === 'schedule' && <MySchedule org={org} />}
        {current === 'time' && <TimeTab org={org} />}
        {current === 'availability' && <AvailabilityTab org={org} />}
        {current === 'certs' && <MyCerts org={org} me={me} />}
        {current === 'org' && <OrgInfo org={org} />}
        {current === 'forms' && <FormsTab org={org} />}
        {current === 'scheduling' && <SchedulingTab org={org} />}
        {current === 'people' && <PeopleTab org={org} />}
        {current === 'training' && <Training org={org} />}
        {current === 'structure' && <StructureTab org={org} />}
        {current === 'budgets' && <BudgetsTab org={org} />}
        {current === 'settings' && <SettingsTab key={org.id} org={org} />}
      </div>
      </FoldGroup>
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

/** A join link: kea://join?s=<server address>&c=<code> (what an organization's server gives out). */
const isLink = (t: string) => /^kea:/i.test(t.trim());
function JoinOrg({ onDone }: { onDone(): void }) {
  const [code, setCode] = useState(() => {
    const l = useWork.getState().joinLink;
    if (l) useWork.setState({ joinLink: null });
    return l ?? '';
  });
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const link = isLink(code);
  const ready = link ? code.includes('c=') : code.replace(/[^A-Za-z0-9]/g, '').length >= 4 && (!!address.trim() || code.replace(/[^A-Za-z0-9]/g, '').length >= 10);
  const join = async () => {
    setBusy(true);
    try {
      // A server's link (or its address and the code): the server proves who it is and Kea signs in with a pass.
      if (link || address.trim()) {
        const r = await api.servers.join(link ? { link: code.trim() } : { address: address.trim(), code: code.trim() });
        if (!r.ok) throw Object.assign(new Error(r.error), { status: r.status, data: r.data });
        toast(r.value.alreadyMember ? `You’re already in ${r.value.org?.name}.` : r.value.pending ? 'Request sent. Your manager approves it.' : `Welcome to ${r.value.org?.name ?? r.value.server.name}.`);
        await refreshOrgs();
        if (r.value.org?.id) useWork.getState().go(r.value.org.id, 'schedule');
        onDone();
        return;
      }
      const r = await post<{ org: Org; alreadyMember: boolean; pending?: boolean }>('/v1/orgs/join', { code });
      toast(r.alreadyMember ? (r.org.memberStatus === 'pending' ? `You already asked to join ${r.org.name}. Your manager approves it.` : `You’re already in ${r.org.name}.`) : r.pending ? 'Request sent. Your manager approves it.' : `Welcome to ${r.org.name}.`);
      await refreshOrgs();
      useWork.getState().go(r.org.id, 'schedule');
      onDone();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Join an organization" className="wk-narrow">
      <Field label="Join link or code" hint={link ? 'Kea checks the organization’s server before signing you in.' : 'From your organization. Dashes and spaces don’t matter.'}>
        <input className={`input ${link ? '' : 'wk-codein'}`} autoFocus value={code} placeholder="kea://join… or ABCD-EFGH-JKMN" onChange={(e) => setCode(isLink(e.target.value) ? e.target.value : e.target.value.toUpperCase())} onKeyDown={(e) => e.key === 'Enter' && ready && !busy && join()} />
      </Field>
      {!link && (
        <Advanced>
          <Field label="Server address" hint="Only when you have the server’s address and a code instead of a link. Put the code above.">
            <input className="input" value={address} placeholder="https://work.example.org" onChange={(e) => setAddress(e.target.value)} />
          </Field>
        </Advanced>
      )}
      <div className="wk-actions">
        <button className="btn" onClick={onDone}>
          Cancel
        </button>
        <button className="btn primary" disabled={busy || !ready} title={!ready ? 'Paste the join link, or enter the whole code' : undefined} onClick={join}>
          Join
        </button>
      </div>
    </Card>
  );
}

/**
 * Making an organization on the Kea account server: a short application (school or employer, the name, a note) that
 * Kea's owner approves; the organization then shows here with you as its owner. The last application shows its status.
 */
function ApplyHosting({ onDone }: { onDone(): void }) {
  const [apps, setApps] = useState<Application[] | null>(null);
  const [orgKind, setOrgKind] = useState<'employer' | 'school'>('employer');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () =>
    get<{ applications: Application[] }>('/v1/apply')
      .then((r) => setApps(r.applications ?? []))
      .catch(() => setApps([]));
  useEffect(() => {
    load();
  }, []);
  const last = latestApplication(apps, 'hosting');
  const waiting = last?.status === 'pending';
  const send = async () => {
    setBusy(true);
    try {
      await post('/v1/apply', { kind: 'hosting', orgKind, name: name.trim(), note: note.trim() });
      toast('Application sent. You’ll get a notification when it’s decided.');
      setName('');
      setNote('');
      await load();
    } catch (e: any) {
      toast(e.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Create an organization" className="wk-narrow">
      {apps === null ? (
        <Loading />
      ) : (
        <>
          {last && <p className={waiting ? 'af-info' : 'muted'}>{applicationLine(last)}</p>}
          {!waiting && (
            <>
              <p className="muted af-small">Kea can host your school’s or employer’s organization: schedules, the time clock, pay codes, forms and training. Tell us a little about it. Once it’s approved it’s set up here, with you as its owner.</p>
              <div className="wk-form-grid">
                <Field label="Kind">
                  <select className="input" value={orgKind} onChange={(e) => setOrgKind(e.target.value === 'school' ? 'school' : 'employer')}>
                    <option value="employer">Employer</option>
                    <option value="school">School</option>
                  </select>
                </Field>
                <Field label="Name">
                  <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="For example Westside Pool" maxLength={120} />
                </Field>
              </div>
              <Field label="A note (optional)" hint="Who it’s for and about how many people.">
                <textarea className="input wk-textarea" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={3} />
              </Field>
            </>
          )}
          <p className="muted af-small">An organization can also run its own KeaS server. Then people join it with its link.</p>
          <div className="wk-actions">
            <button className="btn" onClick={onDone}>
              {waiting ? 'Close' : 'Cancel'}
            </button>
            {!waiting && (
              <button className="btn primary" disabled={busy || name.trim().length < 2} title={name.trim().length < 2 ? 'Give it a name' : undefined} onClick={send}>
                Apply
              </button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

export default WorkScreen;

/** Servers that signed this account out, or can't be reached just now: one calm line each. */
function ServerNotes({ servers }: { servers: JoinedServer[] }) {
  const bad = servers.filter((s) => s.signedOut || s.offline);
  if (!bad.length) return null;
  const again = async (s: JoinedServer) => {
    const r = await api.servers.again(s.serverId);
    if (!r.ok) return toast(r.error, 'error');
    toast(`Signed in to ${s.name ?? 'the organization'} again.`);
    refreshOrgs();
  };
  const remove = async (s: JoinedServer) => {
    if ((await ask(`Remove ${s.name ?? 'this server'} from Kea?`, 'Its organizations go from Work on this computer. Your account and everything on the server stay as they are; join again with a new link.', [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Remove', danger: true, primary: true }])) !== 'yes') return;
    await api.servers.remove(s.serverId);
    refreshOrgs();
  };
  return (
    <>
      {bad.map((s) => (
        <div key={s.serverId} className="wk-server-note">
          <ServerOff size={16} />
          <span className="wk-row-main">
            <span className="wk-row-title">{s.signedOut ? 'This organization signed you out' : `Can’t reach ${s.name ?? 'an organization’s server'} right now`}</span>
            <span className="wk-row-sub">{s.signedOut ? `${s.name ?? s.url}. Ask them to let you back in, then sign in again.` : 'Kea tries again by itself. What it saved before still shows.'}</span>
          </span>
          {s.signedOut && (
            <>
              <button className="btn sm" onClick={() => again(s)}>
                <LogIn size={14} /> Sign in again
              </button>
              <button className="icon-btn sm" title="Remove this server from Kea" onClick={() => remove(s)}>
                <Trash2 size={14} />
              </button>
            </>
          )}
        </div>
      ))}
    </>
  );
}
