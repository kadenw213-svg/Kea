// Certifications and org classes. Members: their certs with countdown colours and their assigned classes.
// Managers: certification types, everyone's records, and org classes whose completion issues a cert.
import { useState } from 'react';
import { Award, GraduationCap, Plus, Trash2, UserCheck } from 'lucide-react';
import { ask, toast } from '../../store';
import { act, clock, fmtDay, todayIso, useHub } from './workStore';
import { Advanced, Card, Empty, Field, Loading, Num, Problem, StageBadge, Seg } from './ui';
import type { Cert, CertType, Member, Org, OrgClass, Structure } from './types';

type CertList = { certs: Cert[]; missing: { accountId: string; typeId: string; typeName: string; positionIds: string[] }[] };

export function MyCerts({ org, me }: { org: Org; me: string | null }) {
  const certs = useHub<CertList>(`/v1/orgs/${org.id}/certs${org.role === 'member' ? '' : `?accountId=${me ?? ''}`}`);
  const classes = useHub<{ classes: OrgClass[] }>(`/v1/orgs/${org.id}/classes`);
  if (certs.error) return <Problem error={certs.error} retry={certs.reload} />;
  if (!certs.data) return <Loading />;
  // The newest record of each certification.
  const latest = new Map<string, Cert>();
  for (const c of certs.data.certs) {
    const cur = latest.get(c.typeId);
    if (!cur || (c.expiresOn ?? '9999') > (cur.expiresOn ?? '9999')) latest.set(c.typeId, c);
  }
  const mine = (classes.data?.classes ?? []).filter((c) => c.mine);
  return (
    <div className="wk-grid2">
      <Card title="My certifications">
        {latest.size === 0 && certs.data.missing.length === 0 && <p className="muted">None on record yet.</p>}
        <div className="wk-certs">
          {certs.data.missing.map((m) => (
            <div key={m.typeId} className="wk-cert bad">
              <Award size={18} />
              <span className="wk-cert-name">{m.typeName}</span>
              <span className="muted">Needed for your position</span>
              <StageBadge stage="missing" />
            </div>
          ))}
          {[...latest.values()].map((c) => (
            <div key={c.id} className={`wk-cert stage-${c.stage}`}>
              <Award size={18} />
              <span className="wk-cert-name">{c.typeName}</span>
              <span className="muted">{c.expiresOn ? `${c.stage === 'expired' ? 'Expired' : 'Expires'} ${fmtDay(c.expiresOn, { month: 'short', day: 'numeric', year: 'numeric' })}` : 'Does not expire'}</span>
              <StageBadge stage={c.stage} daysLeft={c.daysLeft} />
            </div>
          ))}
        </div>
      </Card>
      <Card title="My classes">
        {!classes.data ? (
          <Loading />
        ) : mine.length === 0 ? (
          <p className="muted">No classes assigned.</p>
        ) : (
          <div className="wk-list">
            {mine.map((c) => {
              const next = c.sessions.find((s) => new Date(s.end).getTime() > Date.now());
              return (
                <div key={c.id} className="wk-row">
                  <GraduationCap size={18} />
                  <span className="wk-row-main">
                    <span className="wk-row-title">{c.title}</span>
                    <span className="wk-row-sub">
                      {c.mine?.completedOn
                        ? `Finished ${fmtDay(c.mine.completedOn)}`
                        : next
                          ? `Next: ${fmtDay(next.start.slice(0, 10))} ${clock(next.start, org.tz)}${next.location ? ` · ${next.location}` : ''}`
                          : c.mine?.dueOn
                            ? `Finish by ${fmtDay(c.mine.dueOn)}`
                            : 'No sessions scheduled yet'}
                    </span>
                  </span>
                  {next?.meetingUrl && !c.mine?.completedOn && (
                    <a className="btn sm" href={next.meetingUrl} target="_blank" rel="noreferrer">
                      Join
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}

/** Managers: certification types, records and org classes. */
export function Training({ org }: { org: Org }) {
  const [tab, setTab] = useState<'records' | 'types' | 'classes'>('records');
  return (
    <div>
      <Seg value={tab} onChange={setTab} options={[['records', 'Records'], ['types', 'Certifications'], ['classes', 'Classes']]} />
      <div className="wk-gap" />
      {tab === 'records' ? <Records org={org} /> : tab === 'types' ? <Types org={org} /> : <Classes org={org} />}
    </div>
  );
}

function useBasics(org: Org) {
  const members = useHub<{ members: Member[] }>(`/v1/orgs/${org.id}/members`);
  const structure = useHub<Structure>(`/v1/orgs/${org.id}/structure`);
  const types = useHub<{ certTypes: CertType[] }>(`/v1/orgs/${org.id}/cert-types`);
  return { members: members.data?.members ?? [], structure: structure.data, types: types.data?.certTypes ?? [] };
}

function Records({ org }: { org: Org }) {
  const { data, error, reload } = useHub<CertList>(`/v1/orgs/${org.id}/certs`);
  const { members, types } = useBasics(org);
  const [who, setWho] = useState('');
  const [type, setType] = useState('');
  const [issued, setIssued] = useState(todayIso());
  const [expires, setExpires] = useState('');
  const [filter, setFilter] = useState<'all' | 'soon'>('soon');
  if (error) return <Problem error={error} retry={reload} />;
  if (!data) return <Loading />;
  const rows = data.certs.filter((c) => filter === 'all' || c.stage !== 'ok').sort((a, b) => (a.daysLeft ?? 1e9) - (b.daysLeft ?? 1e9));
  return (
    <div className="wk-stack">
      <Card title="Add a record">
        <div className="wk-form-row">
          <select className="input sm" value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Person…</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <select className="input sm" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Certification…</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <label className="wk-inline">
            Issued <input className="input sm" type="date" value={issued} onChange={(e) => setIssued(e.target.value)} />
          </label>
          <label className="wk-inline" title="Leave empty to use the certification's months valid">
            Expires <input className="input sm" type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </label>
          <button
            className="btn sm primary"
            disabled={!who || !type}
            onClick={async () => {
              if (await act(`/v1/orgs/${org.id}/certs`, { accountId: who, typeId: type, issuedOn: issued, expiresOn: expires || null }, 'Added.')) setExpires('');
            }}
          >
            <Plus size={14} /> Add
          </button>
        </div>
      </Card>
      {data.missing.length > 0 && (
        <Card title="Missing for their position">
          <div className="wk-tags">
            {data.missing.map((m) => (
              <span key={m.accountId + m.typeId} className="wk-pill bad">
                {members.find((x) => x.id === m.accountId)?.name ?? 'Someone'}: {m.typeName}
              </span>
            ))}
          </div>
        </Card>
      )}
      <Card title="Records" actions={<Seg value={filter} onChange={setFilter} options={[['soon', 'Expiring'], ['all', 'All']]} />}>
        {rows.length === 0 ? (
          <p className="muted">{filter === 'soon' ? 'Nothing expiring soon.' : 'No records yet.'}</p>
        ) : (
          <table className="wk-table">
            <thead>
              <tr>
                <th>Person</th>
                <th>Certification</th>
                <th>Issued</th>
                <th>Expires</th>
                <th />
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.typeName}</td>
                  <td>{fmtDay(c.issuedOn, { month: 'short', day: 'numeric', year: 'numeric' })}</td>
                  <td>{c.expiresOn ? fmtDay(c.expiresOn, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'}</td>
                  <td>
                    <StageBadge stage={c.stage} daysLeft={c.daysLeft} />
                  </td>
                  <td>
                    <button
                      className="icon-btn sm"
                      title="Delete"
                      onClick={async () => {
                        if ((await ask('Delete this record?', `${c.name}: ${c.typeName}`, [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Delete', danger: true, primary: true }])) === 'yes') act(`/v1/orgs/${org.id}/certs/${c.id}/delete`);
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function Types({ org }: { org: Org }) {
  const { types, structure } = useBasics(org);
  const admin = org.role === 'admin' || org.role === 'owner';
  const [name, setName] = useState('');
  const [months, setMonths] = useState<number | null>(24);
  const [pos, setPos] = useState<string[]>([]);
  const [warn, setWarn] = useState('60, 30, 7');
  const positions = structure?.positions ?? [];
  const warnList = () => warn.split(/[ ,]+/).map(Number).filter((n) => n > 0);
  return (
    <div className="wk-stack">
      {admin && (
        <Card title="New certification">
          <div className="wk-form-row">
            <input className="input sm" placeholder="Name, for example Lifeguard" value={name} onChange={(e) => setName(e.target.value)} />
            <label className="wk-inline">
              Valid for <Num value={months} onChange={setMonths} /> months
            </label>
          </div>
          <Field label="Required for">
            <div className="wk-tags">
              {positions.map((p) => (
                <button key={p.id} className={`wk-chip ${pos.includes(p.id) ? 'on' : ''}`} onClick={() => setPos(pos.includes(p.id) ? pos.filter((x) => x !== p.id) : [...pos, p.id])}>
                  {p.name}
                </button>
              ))}
              {!positions.length && <span className="muted">Add positions under Structure first.</span>}
            </div>
          </Field>
          <Advanced>
            <Field label="Remind people this many days before it expires" hint="The to-do colours change at each step.">
              <input className="input sm" value={warn} onChange={(e) => setWarn(e.target.value)} />
            </Field>
          </Advanced>
          <div className="wk-actions">
            <button
              className="btn sm primary"
              disabled={!name.trim()}
              onClick={async () => {
                if (await act(`/v1/orgs/${org.id}/cert-types`, { name, validMonths: months, positionIds: pos, warnDays: warnList() }, 'Added.')) {
                  setName('');
                  setPos([]);
                }
              }}
            >
              Add
            </button>
          </div>
        </Card>
      )}
      <Card title="Certifications">
        {types.length === 0 && <p className="muted">None yet.</p>}
        <div className="wk-list">
          {types.map((t) => (
            <div key={t.id} className="wk-row">
              <Award size={18} />
              <span className="wk-row-main">
                <span className="wk-row-title">{t.name}</span>
                <span className="wk-row-sub">
                  {t.validMonths ? `Valid ${t.validMonths} months` : 'Does not expire'}
                  {t.positionIds.length ? ` · Required for ${t.positionIds.map((p) => positions.find((x) => x.id === p)?.name).filter(Boolean).join(', ')}` : ''}
                  {` · Reminders at ${t.warnDays.join(', ')} days`}
                </span>
              </span>
              {admin && (
                <button
                  className="icon-btn sm"
                  title="Delete"
                  onClick={async () => {
                    if ((await ask(`Delete ${t.name}?`, 'Every record of it is deleted too.', [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Delete', danger: true, primary: true }])) === 'yes') act(`/v1/orgs/${org.id}/cert-types/${t.id}/delete`);
                  }}
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function Classes({ org }: { org: Org }) {
  const { data, error, reload } = useHub<{ classes: OrgClass[] }>(`/v1/orgs/${org.id}/classes`);
  const { members, types, structure } = useBasics(org);
  const [title, setTitle] = useState('');
  const [cert, setCert] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  if (error) return <Problem error={error} retry={reload} />;
  if (!data) return <Loading />;
  return (
    <div className="wk-stack">
      <Card title="New class">
        <div className="wk-form-row">
          <input className="input sm" placeholder="Title, for example Lifeguard recertification" value={title} onChange={(e) => setTitle(e.target.value)} />
          <select className="input sm" value={cert} onChange={(e) => setCert(e.target.value)} title="Finishing the class gives this certification">
            <option value="">Gives no certification</option>
            {types.map((t) => (
              <option key={t.id} value={t.id}>
                Gives {t.name}
              </option>
            ))}
          </select>
          <button
            className="btn sm primary"
            disabled={!title.trim()}
            onClick={async () => {
              const r = await act<{ class: OrgClass }>(`/v1/orgs/${org.id}/classes`, { title, certTypeId: cert || null }, 'Class made.');
              if (r) {
                setTitle('');
                setOpen(r.class.id);
              }
            }}
          >
            <Plus size={14} /> Make class
          </button>
        </div>
      </Card>
      {data.classes.length === 0 && <Empty title="No classes yet">Classes you make here are Kea classes too: assigned people see them in Kea, with their sessions on the calendar.</Empty>}
      {data.classes.map((c) => (
        <ClassCard key={c.id} org={org} c={c} open={open === c.id} toggle={() => setOpen(open === c.id ? null : c.id)} members={members} types={types} structure={structure} />
      ))}
    </div>
  );
}

function ClassCard({ org, c, open, toggle, members, types, structure }: { org: Org; c: OrgClass; open: boolean; toggle(): void; members: Member[]; types: CertType[]; structure: Structure | null }) {
  const [pick, setPick] = useState<string[]>([]);
  const [due, setDue] = useState('');
  const [sd, setSd] = useState(todayIso());
  const [st, setSt] = useState('09:00');
  const [en, setEn] = useState('12:00');
  const [loc, setLoc] = useState('');
  const [link, setLink] = useState('');
  const cert = types.find((t) => t.id === c.certTypeId);
  const assigned = c.assigned ?? [];
  const done = assigned.filter((a) => a.completedOn).length;
  return (
    <Card
      title={
        <button className="wk-linkish" onClick={toggle}>
          <GraduationCap size={16} /> {c.title}
        </button>
      }
      actions={
        <span className="muted">
          {cert ? `Gives ${cert.name} · ` : ''}
          {done}/{assigned.length} finished
        </span>
      }
    >
      {open && (
        <div className="wk-stack">
          <Field label="Sessions">
            <div className="wk-list">
              {c.sessions.map((s) => (
                <div key={s.id} className="wk-row">
                  <span className="wk-row-main">
                    <span className="wk-row-title">
                      {fmtDay(s.start.slice(0, 10))} {clock(s.start, org.tz)}–{clock(s.end, org.tz)}
                    </span>
                    <span className="wk-row-sub">{[s.location, s.meetingUrl].filter(Boolean).join(' · ') || 'No place set'}</span>
                  </span>
                  <button className="icon-btn sm" title="Delete" onClick={() => act(`/v1/orgs/${org.id}/classes/${c.id}/sessions/${s.id}/delete`)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </div>
            <div className="wk-form-row">
              <input className="input sm" type="date" value={sd} onChange={(e) => setSd(e.target.value)} />
              <input className="input sm" type="time" value={st} onChange={(e) => setSt(e.target.value)} />
              <input className="input sm" type="time" value={en} onChange={(e) => setEn(e.target.value)} />
              <input className="input sm" placeholder="Place" value={loc} onChange={(e) => setLoc(e.target.value)} />
              <input className="input sm" placeholder="Meeting link (https://…)" value={link} onChange={(e) => setLink(e.target.value)} />
              <button
                className="btn sm"
                onClick={() =>
                  act(`/v1/orgs/${org.id}/classes/${c.id}/sessions`, { start: new Date(`${sd}T${st}`).toISOString(), end: new Date(`${sd}T${en}`).toISOString(), location: loc || null, meetingUrl: link || null }, 'Session added.')
                }
              >
                Add session
              </button>
            </div>
          </Field>
          <Field label="Assign">
            <div className="wk-tags">
              {members.map((m) => (
                <button key={m.id} className={`wk-chip ${pick.includes(m.id) ? 'on' : ''}`} onClick={() => setPick(pick.includes(m.id) ? pick.filter((x) => x !== m.id) : [...pick, m.id])}>
                  {m.name}
                </button>
              ))}
            </div>
            <div className="wk-form-row">
              <label className="wk-inline">
                Finish by <input className="input sm" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
              </label>
              <button className="btn sm primary" disabled={!pick.length} onClick={async () => (await act(`/v1/orgs/${org.id}/classes/${c.id}/assign`, { accountIds: pick, dueOn: due || null }, 'Assigned.')) && setPick([])}>
                Assign {pick.length || ''}
              </button>
              {structure?.positions.map((p) => (
                <button key={p.id} className="btn sm" title={`Everyone who works as ${p.name}`} onClick={() => act(`/v1/orgs/${org.id}/classes/${c.id}/assign`, { positionIds: [p.id], dueOn: due || null }, 'Assigned.')}>
                  All {p.name}
                </button>
              ))}
            </div>
          </Field>
          {assigned.length > 0 && (
            <table className="wk-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Finish by</th>
                  <th>Finished</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {assigned.map((a) => (
                  <tr key={a.accountId}>
                    <td>{a.name}</td>
                    <td>{a.dueOn ? fmtDay(a.dueOn) : '—'}</td>
                    <td>{a.completedOn ? fmtDay(a.completedOn) : '—'}</td>
                    <td>
                      {!a.completedOn && (
                        <button
                          className="btn sm"
                          onClick={async () => {
                            const r = await act<{ issued: unknown[] }>(`/v1/orgs/${org.id}/classes/${c.id}/complete`, { accountIds: [a.accountId] });
                            if (r) toast(r.issued.length ? `Finished. ${cert?.name} certification added.` : 'Finished.');
                          }}
                        >
                          <UserCheck size={13} /> Finished
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Card>
  );
}
