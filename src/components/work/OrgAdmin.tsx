// Running an organization: people and join codes, approvals, structure (departments, positions, locations, cost
// centers), budgets, policies to acknowledge, and settings. Plus the member's own page (who's here, Leave).
import { useEffect, useState } from 'react';
import { Check as CheckIcon, ClipboardCopy, FileSignature, LogOut, Plus, Trash2, X } from 'lucide-react';
import { ask, prompt, toast } from '../../store';
import { act, bump, get, wantText, fmtDay, fmtWhen, money, useHub, useWork, todayIso, addDays, localTz } from './workStore';
import { Advanced, Card, Check, Empty, Field, Loading, Num, Problem, Seg } from './ui';
import { RANK } from './types';
import type { BudgetRow, Department, JoinCode, Member, Org, OrgSettings, Policy, Role, Structure, Swap } from './types';
import { SupporterBadge } from '../scholar/HubAccount';

const ROLE: Record<Role, string> = { owner: 'Owner', admin: 'Admin', manager: 'Manager', member: 'Member' };
const isAdmin = (o: Org) => RANK[o.role] >= RANK.admin;

// ---------- people ----------
export function PeopleTab({ org }: { org: Org }) {
  const focus = useWork((s) => s.focus);
  const [tab, setTab] = useState<'people' | 'approvals' | 'codes'>(focus?.view === 'approvals' ? 'approvals' : 'people');
  useEffect(() => {
    if (focus?.view === 'approvals') setTab('approvals');
  }, [focus?.view]);
  return (
    <div>
      <Seg value={tab} onChange={setTab} options={[['people', 'People'], ['approvals', 'Approvals'], ['codes', 'Join codes']]} />
      <div className="wk-gap" />
      {tab === 'people' ? <People org={org} /> : tab === 'approvals' ? <Approvals org={org} /> : <Codes org={org} />}
    </div>
  );
}

function People({ org }: { org: Org }) {
  const { data, error, reload } = useHub<{ members: Member[]; pending: Member[] }>(`/v1/orgs/${org.id}/members`);
  const st = useHub<Structure>(`/v1/orgs/${org.id}/structure`);
  const [edit, setEdit] = useState<string | null>(null);
  if (error) return <Problem error={error} retry={reload} />;
  if (!data) return <Loading />;
  const s = st.data;
  return (
    <table className="wk-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Role</th>
          <th>Department</th>
          <th>Positions</th>
          <th>Hours wanted</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {data.members.map((m) =>
          edit === m.id ? (
            <EditMember key={m.id} org={org} m={m} s={s} done={() => setEdit(null)} />
          ) : (
            <tr key={m.id}>
              <td>
                {m.name}
                {m.supporter && <SupporterBadge />}
                {m.minor && <span className="wk-pill sm">Under 18</span>}
                <div className="muted af-small">
                  {m.email}
                  {m.phone && <> · {m.phone}</>}
                </div>
              </td>
              <td>{ROLE[m.role]}</td>
              <td>{s?.departments.find((d) => d.id === m.departmentId)?.name ?? '—'}</td>
              <td>{m.positionIds.map((p) => s?.positions.find((x) => x.id === p)?.name).filter(Boolean).join(', ') || '—'}</td>
              <td>{wantText(m.desiredMin, m.desiredMax) ?? '—'}</td>
              <td className="wk-nowrap">
                {(RANK[m.role] < RANK[org.role] || org.role === 'owner') && !m.you && (
                  <>
                    <button className="btn sm" onClick={() => setEdit(m.id)}>
                      Edit
                    </button>
                    <button
                      className="icon-btn sm"
                      title="Remove from the organization"
                      onClick={async () => {
                        if ((await ask(`Remove ${m.name}?`, 'Their upcoming shifts open up again.', [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Remove', danger: true, primary: true }])) === 'yes') act(`/v1/orgs/${org.id}/members/${m.id}/remove`, {}, 'Removed.');
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </>
                )}
              </td>
            </tr>
          )
        )}
      </tbody>
    </table>
  );
}

function EditMember({ org, m, s, done }: { org: Org; m: Member; s: Structure | null; done(): void }) {
  const [role, setRole] = useState(m.role);
  const [dept, setDept] = useState(m.departmentId ?? '');
  const [pos, setPos] = useState<string[]>(m.positionIds);
  const [title, setTitle] = useState(m.title ?? '');
  const [birth, setBirth] = useState(m.birthdate ?? '');
  const [rate, setRate] = useState<number | null>(m.costRate ?? null);
  const admin = isAdmin(org);
  const roles: Role[] = org.role === 'owner' ? ['owner', 'admin', 'manager', 'member'] : ['manager', 'member'];
  return (
    <tr className="wk-editing">
      <td colSpan={6}>
        <div className="wk-form-grid">
          <Field label="Role">
            <select className="input sm" value={role} disabled={!admin} onChange={(e) => setRole(e.target.value as Role)}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {ROLE[r]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Department">
            <select className="input sm" value={dept} onChange={(e) => setDept(e.target.value)}>
              <option value="">None</option>
              {s?.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Title">
            <input className="input sm" value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          {admin && (
            <Field label="Birthdate" hint="Only for the under-18 work rules.">
              <input className="input sm" type="date" value={birth} onChange={(e) => setBirth(e.target.value)} />
            </Field>
          )}
          {admin && (
            <Field label="Cost per hour" hint="For budgets. Pay itself stays in payroll, never on the Hub.">
              <Num value={rate} onChange={setRate} step={0.25} />
            </Field>
          )}
        </div>
        <Field label="Positions">
          <div className="wk-tags">
            {s?.positions.map((p) => (
              <button key={p.id} className={`wk-chip ${pos.includes(p.id) ? 'on' : ''}`} onClick={() => setPos(pos.includes(p.id) ? pos.filter((x) => x !== p.id) : [...pos, p.id])}>
                {p.name}
              </button>
            ))}
          </div>
        </Field>
        <div className="wk-actions">
          <button className="btn sm" onClick={done}>
            Cancel
          </button>
          <button
            className="btn sm primary"
            onClick={async () => {
              const body: Record<string, unknown> = { departmentId: dept || null, positionIds: pos, title: title || null };
              if (role !== m.role) body.role = role;
              if (admin) Object.assign(body, { birthdate: birth || null, costRate: rate });
              if (await act(`/v1/orgs/${org.id}/members/${m.id}`, body, 'Saved.')) done();
            }}
          >
            Save
          </button>
        </div>
      </td>
    </tr>
  );
}

function Approvals({ org }: { org: Org }) {
  const members = useHub<{ members: Member[]; pending: Member[] }>(`/v1/orgs/${org.id}/members`);
  const swaps = useHub<{ swaps: Swap[] }>(`/v1/orgs/${org.id}/swaps`);
  const forms = useHub<{ forms: { id: string; title: string; status: string }[] }>(`/v1/orgs/${org.id}/forms`);
  const go = useWork((s) => s.go);
  const pending = members.data?.pending ?? [];
  const claimed = (swaps.data?.swaps ?? []).filter((w) => w.status === 'claimed');
  return (
    <div className="wk-stack">
      <Card title="Asking to join">
        {!pending.length && <p className="muted">Nobody waiting.</p>}
        {pending.map((m) => (
          <div key={m.id} className="wk-row">
            <span className="wk-row-main">
              <span className="wk-row-title">{m.name}</span>
              <span className="wk-row-sub">
                {m.email} · as {ROLE[m.role]}
              </span>
            </span>
            <button className="btn sm" onClick={() => act(`/v1/orgs/${org.id}/members/${m.id}/approve`, { approve: false }, 'Declined.')}>
              <X size={14} /> Decline
            </button>
            <button className="btn sm primary" onClick={() => act(`/v1/orgs/${org.id}/members/${m.id}/approve`, { approve: true }, `${m.name} is in.`)}>
              <CheckIcon size={14} /> Approve
            </button>
          </div>
        ))}
      </Card>
      <Card title="Shift swaps">
        {!claimed.length && <p className="muted">Nothing waiting.</p>}
        {claimed.map((w) => (
          <div key={w.id} className="wk-row">
            <span className="wk-row-main">
              <span className="wk-row-title">
                {w.claimantName} takes {w.fromName}’s shift
              </span>
              <span className="wk-row-sub">
                {w.shift?.positionName} · {w.shift && fmtDay(w.shift.date)} · {w.shift && new Date(w.shift.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: org.tz })}
                {w.note ? ` · “${w.note}”` : ''}
              </span>
            </span>
            <button className="btn sm" onClick={() => act(`/v1/orgs/${org.id}/swaps/${w.id}/decide`, { approve: false }, 'Declined.')}>
              <X size={14} /> Decline
            </button>
            <button className="btn sm primary" onClick={() => act(`/v1/orgs/${org.id}/swaps/${w.id}/decide`, { approve: true }, 'Approved.')}>
              <CheckIcon size={14} /> Approve
            </button>
          </div>
        ))}
      </Card>
      <Card title="Availability changes">
        <p className="muted af-small">Changes after a deadline are in each form, under Changes.</p>
        <div className="wk-tags">
          {(forms.data?.forms ?? [])
            .filter((f) => f.status !== 'draft')
            .map((f) => (
              <button key={f.id} className="wk-chip" onClick={() => go(org.id, 'forms', { formId: f.id, view: 'changes' })}>
                {f.title}
              </button>
            ))}
        </div>
      </Card>
    </div>
  );
}

function Codes({ org }: { org: Org }) {
  const { data, error } = useHub<{ codes: JoinCode[] }>(`/v1/orgs/${org.id}/codes`);
  const st = useHub<Structure>(`/v1/orgs/${org.id}/structure`);
  const [role, setRole] = useState<Role>('member');
  const [days, setDays] = useState<number | null>(30);
  const [max, setMax] = useState<number | null>(null);
  const [approval, setApproval] = useState(false);
  const [pos, setPos] = useState('');
  const [dept, setDept] = useState('');
  const [label, setLabel] = useState('');
  const can: Role[] = org.role === 'owner' ? ['member', 'manager', 'admin'] : org.role === 'admin' ? ['member', 'manager'] : ['member'];
  const fmt = (c: string) => c.replace(/(.{4})(?=.)/g, '$1-');
  return (
    <div className="wk-stack">
      <Card title="New join code">
        <div className="wk-form-row">
          <select className="input sm wk-auto" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {can.map((r) => (
              <option key={r} value={r}>
                For {ROLE[r].toLowerCase()}s
              </option>
            ))}
          </select>
          <label className="wk-inline">
            Works for <Num value={days} onChange={setDays} max={365} /> days
          </label>
          <Check label="I approve each person" checked={approval || role !== 'member'} onChange={setApproval} />
          <button
            className="btn sm primary"
            onClick={() =>
              act(`/v1/orgs/${org.id}/codes`, { role, expiresDays: days || null, maxUses: max || null, needsApproval: role !== 'member' ? true : approval, positionId: pos || null, departmentId: dept || null, label: label || null }, 'Code made.')
            }
          >
            <Plus size={14} /> Make code
          </button>
        </div>
        <Advanced>
          <div className="wk-form-grid">
            <Field label="Most people who can use it">
              <Num value={max} onChange={setMax} placeholder="No limit" max={10000} />
            </Field>
            <Field label="Gives the position">
              <select className="input sm" value={pos} onChange={(e) => setPos(e.target.value)}>
                <option value="">None</option>
                {st.data?.positions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Puts them in">
              <select className="input sm" value={dept} onChange={(e) => setDept(e.target.value)}>
                <option value="">No department</option>
                {st.data?.departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Label (for you)">
              <input className="input sm" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="For example Summer hires" />
            </Field>
          </div>
        </Advanced>
      </Card>
      <Problem error={error} />
      {data && (
        <Card title="Codes">
          {!data.codes.length && <p className="muted">No codes yet.</p>}
          {data.codes.map((c) => (
            <div key={c.code} className={`wk-row ${c.usable ? '' : 'wk-dim'}`}>
              <code className="wk-code">{fmt(c.code)}</code>
              <span className="wk-row-main">
                <span className="wk-row-title">
                  {ROLE[c.role]}
                  {c.label ? ` · ${c.label}` : ''}
                  {c.needsApproval ? ' · you approve each' : ''}
                </span>
                <span className="wk-row-sub">
                  Used {c.uses}
                  {c.maxUses ? ` of ${c.maxUses}` : ''} · {c.expiresAt ? (c.expiresAt > Date.now() ? `until ${fmtWhen(c.expiresAt)}` : 'expired') : 'no end date'}
                </span>
              </span>
              <button
                className="icon-btn sm"
                title="Copy"
                onClick={() => {
                  navigator.clipboard.writeText(fmt(c.code));
                  toast('Copied.');
                }}
              >
                <ClipboardCopy size={14} />
              </button>
              <button className="btn sm" onClick={() => act(`/v1/orgs/${org.id}/codes/${c.code}/revoke`, {}, 'Revoked. It no longer works.')}>
                Revoke
              </button>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// ---------- structure ----------
export function StructureTab({ org }: { org: Org }) {
  const { data, error, reload } = useHub<Structure>(`/v1/orgs/${org.id}/structure`);
  if (error) return <Problem error={error} retry={reload} />;
  if (!data) return <Loading />;
  const kids = (pid: string | null) => data.departments.filter((d) => d.parentId === pid);
  const addDept = async (parentId: string | null) => {
    const name = await prompt(parentId ? 'New team under it' : 'New department', 'Name');
    if (name) act(`/v1/orgs/${org.id}/departments`, { name, parentId }, 'Added.');
  };
  const Tree = ({ pid, depth }: { pid: string | null; depth: number }) => (
    <>
      {kids(pid).map((d) => (
        <div key={d.id}>
          <DeptRow org={org} d={d} depth={depth} all={data} onAdd={() => addDept(d.id)} />
          <Tree pid={d.id} depth={depth + 1} />
        </div>
      ))}
    </>
  );
  return (
    <div className="wk-grid2">
      <Card
        title="Departments"
        actions={
          <button className="btn link sm" onClick={() => addDept(null)}>
            <Plus size={13} /> Department
          </button>
        }
      >
        {!data.departments.length && <p className="muted">Departments can hold teams, and teams can hold teams, as deep as you need.</p>}
        <Tree pid={null} depth={0} />
      </Card>
      <Positions org={org} s={data} />
      <SimpleList org={org} title="Locations" path="locations" items={data.locations.map((l) => ({ id: l.id, a: l.name, b: l.address ?? '' }))} fields={['name', 'address']} labels={['Name', 'Address']} />
      <SimpleList org={org} title="Cost centers" path="cost-centers" items={data.costCenters.map((c) => ({ id: c.id, a: c.code, b: c.name }))} fields={['code', 'name']} labels={['Code', 'Name']} />
    </div>
  );
}

function DeptRow({ org, d, depth, all, onAdd }: { org: Org; d: Department; depth: number; all: Structure; onAdd(): void }) {
  const others = all.departments.filter((x) => x.id !== d.id);
  return (
    <div className="st-dept" style={{ paddingLeft: depth * 20 }}>
      <input className="input sm st-name" defaultValue={d.name} onBlur={(e) => e.target.value !== d.name && e.target.value.trim() && act(`/v1/orgs/${org.id}/departments/${d.id}`, { name: e.target.value })} />
      <select className="input sm wk-auto" value={d.parentId ?? ''} title="Under" onChange={(e) => act(`/v1/orgs/${org.id}/departments/${d.id}`, { parentId: e.target.value || null })}>
        <option value="">Top level</option>
        {others.map((o) => (
          <option key={o.id} value={o.id}>
            Under {o.name}
          </option>
        ))}
      </select>
      <select className="input sm wk-auto" value={d.costCenterId ?? ''} title="Cost center" onChange={(e) => act(`/v1/orgs/${org.id}/departments/${d.id}`, { costCenterId: e.target.value || null })}>
        <option value="">No cost center</option>
        {all.costCenters.map((c) => (
          <option key={c.id} value={c.id}>
            {c.code}
          </option>
        ))}
      </select>
      <select className="input sm wk-auto" value={d.locationId ?? ''} title="Location" onChange={(e) => act(`/v1/orgs/${org.id}/departments/${d.id}`, { locationId: e.target.value || null })}>
        <option value="">No location</option>
        {all.locations.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
      <button className="icon-btn sm" title="Add a team under it" onClick={onAdd}>
        <Plus size={14} />
      </button>
      <button
        className="icon-btn sm"
        title="Delete"
        onClick={async () => {
          if ((await ask(`Delete ${d.name}?`, 'Teams and people in it move up a level. Its budgets are deleted.', [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Delete', danger: true, primary: true }])) === 'yes') act(`/v1/orgs/${org.id}/departments/${d.id}/delete`);
        }}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function Positions({ org, s }: { org: Org; s: Structure }) {
  const [name, setName] = useState('');
  return (
    <Card title="Positions">
      {s.positions.map((p) => (
        <div key={p.id} className="st-dept">
          <input className="input sm st-name" defaultValue={p.name} onBlur={(e) => e.target.value !== p.name && e.target.value.trim() && act(`/v1/orgs/${org.id}/positions/${p.id}`, { name: e.target.value })} />
          <select className="input sm wk-auto" value={p.departmentId ?? ''} onChange={(e) => act(`/v1/orgs/${org.id}/positions/${p.id}`, { departmentId: e.target.value || null })}>
            <option value="">No department</option>
            {s.departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <label className="wk-inline" title="Cost per hour, for budgets">
            $<Num value={p.costRate ?? null} step={0.25} onChange={(v) => act(`/v1/orgs/${org.id}/positions/${p.id}`, { costRate: v })} />
            /h
          </label>
          <input
            className="input sm"
            placeholder="Tags (lifeguard, front desk…)"
            title="Words the labor rules match, for example lifeguard for the federal age limit"
            defaultValue={p.tags.join(', ')}
            onBlur={(e) => act(`/v1/orgs/${org.id}/positions/${p.id}`, { tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })}
          />
          <button className="icon-btn sm" title="Delete" onClick={() => act(`/v1/orgs/${org.id}/positions/${p.id}/delete`)}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div className="wk-form-row">
        <input className="input sm" placeholder="New position, for example Lifeguard" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="btn sm" disabled={!name.trim()} onClick={async () => (await act(`/v1/orgs/${org.id}/positions`, { name, tags: [name.toLowerCase()] }, 'Added.')) && setName('')}>
          <Plus size={14} /> Add
        </button>
      </div>
    </Card>
  );
}

function SimpleList({ org, title, path, items, fields, labels }: { org: Org; title: string; path: string; items: { id: string; a: string; b: string }[]; fields: [string, string]; labels: [string, string] }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  return (
    <Card title={title}>
      {items.map((x) => (
        <div key={x.id} className="st-dept">
          <input className="input sm" defaultValue={x.a} onBlur={(e) => e.target.value !== x.a && act(`/v1/orgs/${org.id}/${path}/${x.id}`, { [fields[0]]: e.target.value })} />
          <input className="input sm" defaultValue={x.b} onBlur={(e) => e.target.value !== x.b && act(`/v1/orgs/${org.id}/${path}/${x.id}`, { [fields[1]]: e.target.value })} />
          <button className="icon-btn sm" title="Delete" onClick={() => act(`/v1/orgs/${org.id}/${path}/${x.id}/delete`)}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div className="wk-form-row">
        <input className="input sm" placeholder={labels[0]} value={a} onChange={(e) => setA(e.target.value)} />
        <input className="input sm" placeholder={labels[1]} value={b} onChange={(e) => setB(e.target.value)} />
        <button
          className="btn sm"
          disabled={!a.trim()}
          onClick={async () => {
            if (await act(`/v1/orgs/${org.id}/${path}`, { [fields[0]]: a, [fields[1]]: b || (fields[1] === 'name' ? a : null) }, 'Added.')) {
              setA('');
              setB('');
            }
          }}
        >
          <Plus size={14} /> Add
        </button>
      </div>
    </Card>
  );
}

// ---------- budgets ----------
export function BudgetsTab({ org }: { org: Org }) {
  const { data, error, reload } = useHub<{ budgets: BudgetRow[]; unbudgeted: { departmentId: string | null; scheduled: number; hours: number }[]; warnPct: number }>(`/v1/orgs/${org.id}/budgets`);
  const st = useHub<Structure>(`/v1/orgs/${org.id}/structure`);
  const [dept, setDept] = useState('');
  const n = new Date();
  const [start, setStart] = useState(todayIso().slice(0, 8) + '01');
  const [end, setEnd] = useState(() => addDays(`${new Date(n.getFullYear(), n.getMonth() + 1, 1).toISOString().slice(0, 7)}-01`, -1));
  const [amount, setAmount] = useState<number | null>(null);
  const [label, setLabel] = useState('Original');
  if (error) return <Problem error={error} retry={reload} />;
  if (!data) return <Loading />;
  const names = new Map((st.data?.departments ?? []).map((d) => [d.id, d.name]));
  return (
    <div className="wk-stack">
      {isAdmin(org) && (
        <Card title="Set a budget">
          <div className="wk-form-row">
            <select className="input sm wk-auto" value={dept} onChange={(e) => setDept(e.target.value)}>
              <option value="">Department…</option>
              {st.data?.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <input className="input sm wk-auto" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
            <span>to</span>
            <input className="input sm wk-auto" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
            <label className="wk-inline">
              $<Num value={amount} onChange={setAmount} step={100} />
            </label>
            <button className="btn sm primary" disabled={!dept || !amount} onClick={() => act(`/v1/orgs/${org.id}/budgets`, { departmentId: dept, periodStart: start, periodEnd: end, amount, label }, 'Budget set.')}>
              Set
            </button>
          </div>
          <Advanced>
            <Field label="Version" hint="A new version for the same department and dates replaces the old one; both are kept.">
              <input className="input sm" value={label} onChange={(e) => setLabel(e.target.value)} />
            </Field>
          </Advanced>
        </Card>
      )}
      <Card title="Labor against budget" actions={<span className="muted">Warns at {data.warnPct}%</span>}>
        {!data.budgets.length && <p className="muted">No budgets for these months. Teams’ costs roll up into their department’s budget.</p>}
        {data.budgets.map((b) => (
          <div key={b.id} className={`bud ${b.current ? '' : 'wk-dim'} ${b.over ? 'bad' : b.warn ? 'warn' : ''}`}>
            <div className="bud-head">
              <b>{b.departmentName}</b>
              <span className="muted">
                {fmtDay(b.periodStart, { month: 'short', day: 'numeric' })} – {fmtDay(b.periodEnd, { month: 'short', day: 'numeric' })} · {b.label}
                {b.current ? '' : ' (replaced)'}
              </span>
              <span className="wk-spacer" />
              <span>
                {money(b.scheduled)} of {money(b.amount)} {b.pct != null && `(${b.pct}%)`}
              </span>
              {isAdmin(org) && (
                <button className="icon-btn sm" title="Delete" onClick={() => act(`/v1/orgs/${org.id}/budgets/${b.id}/delete`)}>
                  <Trash2 size={14} />
                </button>
              )}
            </div>
            <div className="wk-bar big">
              <div className="worked" style={{ width: `${Math.min(100, (b.worked / b.amount) * 100)}%` }} />
              <div className="pub" style={{ width: `${Math.min(100, ((b.published - b.worked) / b.amount) * 100)}%` }} />
              <div className="draft" style={{ width: `${Math.max(0, Math.min(100, ((b.scheduled - b.published) / b.amount) * 100))}%` }} />
            </div>
            <div className="bud-legend muted">
              <span>
                <i className="worked" /> Worked {money(b.worked)}
              </span>
              <span>
                <i className="pub" /> Published {money(b.published)}
              </span>
              <span>
                <i className="draft" /> In drafts {money(b.scheduled - b.published)}
              </span>
              <span>{b.hours} h</span>
            </div>
          </div>
        ))}
      </Card>
      {data.unbudgeted.length > 0 && (
        <Card title="Scheduled cost by department">
          <table className="wk-table">
            <tbody>
              {data.unbudgeted.map((u) => (
                <tr key={u.departmentId ?? 'none'}>
                  <td>{u.departmentId ? names.get(u.departmentId) ?? '—' : 'No department'}</td>
                  <td>{u.hours} h</td>
                  <td>{money(u.scheduled)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

// ---------- settings ----------
const TODO_LABEL: Record<string, string> = {
  availability: 'Availability forms due',
  cert: 'Cert countdowns',
  class: 'Assigned classes',
  swap: 'Shift swaps',
  ack: 'Acknowledgments',
  missing: 'Missing availability (managers)',
  approvals: 'Approvals waiting (managers)',
  budget: 'Budget warnings (managers)',
  drafts: 'Schedule drafts to review (managers)',
  staffcerts: 'Staff with expired certs (managers)'
};
export function SettingsTab({ org }: { org: Org }) {
  const [name, setName] = useState(org.name);
  const [tz, setTz] = useState(org.tz);
  const [state, setState] = useState(org.state ?? '');
  const [ws, setWs] = useState(org.workweekStart);
  const [s, setS] = useState<OrgSettings>(org.settings!);
  const save = (extra: Record<string, unknown> = {}) => act(`/v1/orgs/${org.id}`, { name, tz, state: state || null, workweekStart: ws, settings: s, ...extra }, 'Saved.').then((r) => r && refreshOrgs());
  return (
    <div className="wk-stack wk-narrow">
      <Card title="Organization">
        <div className="wk-form-grid">
          <Field label="Name">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Time zone">
            <input className="input" value={tz} onChange={(e) => setTz(e.target.value)} placeholder={localTz()} />
          </Field>
          <Field label="State" hint="Two letters. Picks the labor rules (minors, overtime) on top of federal ones.">
            <input className="input" value={state} maxLength={2} onChange={(e) => setState(e.target.value.toUpperCase())} />
          </Field>
          <Field label="Week starts on">
            <select className="input" value={ws} onChange={(e) => setWs(Number(e.target.value))}>
              {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Check label="Shift swaps need a manager’s approval" checked={s.swapNeedsApproval} onChange={(v) => setS({ ...s, swapNeedsApproval: v })} />
        <Check label="Everyone can see the whole schedule" checked={s.membersSeeSchedule} onChange={(v) => setS({ ...s, membersSeeSchedule: v })} />
        <Advanced>
          <Check label="Let people join with a code without approval, even when the code asks for it" checked={s.autoApproveJoins} onChange={(v) => setS({ ...s, autoApproveJoins: v })} />
          <Field label="Warn when a budget reaches (%)">
            <Num value={s.budgetWarnPct} onChange={(v) => setS({ ...s, budgetWarnPct: v ?? 90 })} max={200} />
          </Field>
          <Field label="Cert reminders (days before expiry) for new certifications">
            <input className="input" value={s.certWarnDays.join(', ')} onChange={(e) => setS({ ...s, certWarnDays: e.target.value.split(/[ ,]+/).map(Number).filter((n) => n > 0) })} />
          </Field>
          <Field label="Availability reminders (hours before the deadline) for new forms">
            <input className="input" value={s.reminders.join(', ')} onChange={(e) => setS({ ...s, reminders: e.target.value.split(/[ ,]+/).map(Number).filter((n) => Number.isFinite(n) && n >= 0) })} />
          </Field>
          <Field label="Auto-fill">
            <Check label="Use people who said If needed" checked={s.autofill.useIfNeeded} onChange={(v) => setS({ ...s, autofill: { ...s.autofill, useIfNeeded: v } })} />
            <Check label="Never go past the hours people want" checked={s.autofill.hardMaxHours} onChange={(v) => setS({ ...s, autofill: { ...s.autofill, hardMaxHours: v } })} />
            <Check label="Allow overtime" checked={s.autofill.allowOvertime} onChange={(v) => setS({ ...s, autofill: { ...s.autofill, allowOvertime: v } })} />
          </Field>
          <Field label="What shows in to-do lists">
            {Object.keys(TODO_LABEL).map((k) => (
              <Check key={k} label={TODO_LABEL[k]} checked={s.todoKinds[k] !== false} onChange={(v) => setS({ ...s, todoKinds: { ...s.todoKinds, [k]: v } })} />
            ))}
          </Field>
        </Advanced>
        <div className="wk-actions">
          <button className="btn primary" onClick={() => save()}>
            Save
          </button>
        </div>
      </Card>
      <Policies org={org} />
    </div>
  );
}

function Policies({ org }: { org: Org }) {
  const { data } = useHub<{ policies: Policy[] }>(`/v1/orgs/${org.id}/policies`);
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [due, setDue] = useState('');
  return (
    <Card title="Policies to acknowledge">
      {data?.policies.map((p) => (
        <div key={p.id} className="wk-row">
          <FileSignature size={16} />
          <span className="wk-row-main">
            <span className="wk-row-title">{p.title}</span>
            <span className="wk-row-sub">
              {p.acked}/{p.audienceCount} acknowledged{p.dueOn ? ` · by ${fmtDay(p.dueOn)}` : ''}
            </span>
          </span>
          <button className="icon-btn sm" title="Delete" onClick={() => act(`/v1/orgs/${org.id}/policies/${p.id}/delete`)}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div className="wk-form-row">
        <input className="input sm" placeholder="Title, for example Pool rules 2027" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input className="input sm" placeholder="Link (https://…)" value={url} onChange={(e) => setUrl(e.target.value)} />
        <input className="input sm wk-auto" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        <button className="btn sm" disabled={!title.trim()} onClick={async () => (await act(`/v1/orgs/${org.id}/policies`, { title, url: url || null, dueOn: due || null }, 'Added to everyone’s to-do list.')) && setTitle('')}>
          <Plus size={14} /> Add
        </button>
      </div>
    </Card>
  );
}

// ---------- the member's page ----------
export function OrgInfo({ org }: { org: Org }) {
  const members = useHub<{ members: Member[] }>(`/v1/orgs/${org.id}/members`);
  const policies = useHub<{ policies: Policy[] }>(`/v1/orgs/${org.id}/policies`);
  const go = useWork((s) => s.go);
  const leave = async () => {
    if ((await ask(`Leave ${org.name}?`, 'Your upcoming shifts open up again, and you’ll need a new code to come back.', [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Leave', danger: true, primary: true }])) !== 'yes') return;
    if (await act(`/v1/orgs/${org.id}/leave`, {}, `You left ${org.name}.`)) {
      await refreshOrgs();
      go(useWork.getState().orgs?.[0]?.id ?? null);
    }
  };
  const open = (policies.data?.policies ?? []).filter((p) => !p.ackedAt);
  return (
    <div className="wk-grid2">
      {(policies.data?.policies.length ?? 0) > 0 && (
        <Card title="Policies">
          {policies.data!.policies.map((p) => (
            <div key={p.id} className="wk-row">
              <FileSignature size={16} />
              <span className="wk-row-main">
                <span className="wk-row-title">{p.title}</span>
                <span className="wk-row-sub">{p.ackedAt ? `Acknowledged ${fmtWhen(p.ackedAt)}` : p.dueOn ? `By ${fmtDay(p.dueOn)}` : 'Please read and acknowledge'}</span>
              </span>
              {p.url && (
                <a className="btn sm" href={p.url} target="_blank" rel="noreferrer">
                  Read
                </a>
              )}
              {!p.ackedAt && (
                <button className="btn sm primary" onClick={() => act(`/v1/orgs/${org.id}/policies/${p.id}/ack`, {}, 'Acknowledged.')}>
                  I’ve read it
                </button>
              )}
            </div>
          ))}
          {!open.length && <p className="muted af-small">All acknowledged.</p>}
        </Card>
      )}
      <Card title={`People (${members.data?.members.length ?? ''})`}>
        <div className="wk-people">
          {members.data?.members.map((m) => (
            <span key={m.id} className="wk-person">
              {m.name}
              {m.supporter && <SupporterBadge compact />}
              {m.role !== 'member' && <span className="muted"> · {ROLE[m.role]}</span>}
              {m.phone && <span className="muted"> · {m.phone}</span>}
            </span>
          ))}
        </div>
      </Card>
      <Card title="Membership">
        <p className="muted">
          You’re {ROLE[org.role].toLowerCase() === 'owner' ? 'an owner' : `a ${ROLE[org.role].toLowerCase()}`} of {org.name}.
        </p>
        <div className="wk-actions">
          <button className="btn danger" onClick={leave}>
            <LogOut size={14} /> Leave {org.name}
          </button>
        </div>
      </Card>
    </div>
  );
}

/** Reload the list of my organizations. */
export async function refreshOrgs() {
  try {
    const r = await get<{ orgs: Org[] }>('/v1/orgs');
    useWork.getState().setOrgs(r.orgs);
    bump();
  } catch (e: any) {
    toast(e.message, 'error');
  }
}
