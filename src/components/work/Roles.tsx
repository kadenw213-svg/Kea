// People → Roles (only for those who can make or give roles, on a server with custom roles): the organization's
// roles, each a list of ticked abilities, and who holds it, for the whole organization or for chosen departments.
// The server enforces the rules (nobody gives what they don't have; an organization always keeps an owner) and its
// message is shown when it refuses.
import { useState } from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { ask, prompt } from '../../store';
import { act, useHub } from './workStore';
import { Card, Empty, Loading, Problem } from './ui';
import { can } from './types';
import type { AbilityInfo, Member, Org, OrgRole, RoleGrant, Structure } from './types';

/** The ability groups shown in the editor (anything a newer server adds lands in Other). */
const GROUPS: [string, string][] = [
  ['people.', 'People'],
  ['roles.', 'Roles'],
  ['codes.', 'People'],
  ['schedule.', 'Schedules and shifts'],
  ['swaps.', 'Schedules and shifts'],
  ['forms.', 'Schedules and shifts'],
  ['clock.', 'Time clock'],
  ['timecards.', 'Time clock'],
  ['timeoff.', 'Time clock'],
  ['certs.', 'Training'],
  ['classes.', 'Training'],
  ['policies.', 'Training'],
  ['budgets.', 'Pay, rates and budgets'],
  ['rates.', 'Pay, rates and budgets'],
  ['paycodes.', 'Pay, rates and budgets'],
  ['structure.', 'Organization'],
  ['settings.', 'Organization'],
];
const groupOf = (id: string) => GROUPS.find(([p]) => id.startsWith(p))?.[1] ?? 'Other';

export function RolesTab({ org }: { org: Org }) {
  const roles = useHub<{ roles: OrgRole[]; abilities: AbilityInfo[] }>(`/v1/orgs/${org.id}/roles`);
  const members = useHub<{ members: Member[] }>(`/v1/orgs/${org.id}/members`);
  const st = useHub<Structure>(`/v1/orgs/${org.id}/structure`);
  const [sel, setSel] = useState<string | null>(null);
  if (roles.error) return <Problem error={roles.error} retry={roles.reload} />;
  if (!roles.data) return <Loading />;
  const manage = can(org, 'roles.manage', null);
  const list = roles.data.roles;
  const cur = list.find((r) => r.id === sel) ?? list[0] ?? null;
  const add = async () => {
    const name = await prompt('New role', 'Name', '', 'For example Shift lead');
    if (!name?.trim()) return;
    const r = await act<{ role: OrgRole }>(`/v1/orgs/${org.id}/roles`, { name: name.trim(), abilities: [] }, 'Role made. Tick what it can do.');
    if (r) setSel(r.role.id);
  };
  return (
    <div className="wk-roles">
      <Card
        title="Roles"
        actions={
          manage && (
            <button className="btn link sm" onClick={add}>
              <Plus size={13} /> Role
            </button>
          )
        }
      >
        <div className="wk-role-list">
          {list.map((r) => (
            <button key={r.id} className={`wk-row-btn ${cur?.id === r.id ? 'on' : ''}`} onClick={() => setSel(r.id)}>
              <span className="wk-row-main">
                <span className="wk-row-title">{r.name}</span>
                <span className="wk-row-sub">
                  {r.templateKey === 'owner' ? 'Everything' : `${r.abilities.length} of ${roles.data!.abilities.length}`}
                  {r.holders != null ? ` · ${r.holders} ${r.holders === 1 ? 'person' : 'people'}` : ''}
                </span>
              </span>
            </button>
          ))}
        </div>
      </Card>
      {cur ? <RoleDetail key={cur.id} org={org} role={cur} catalog={roles.data.abilities} members={members.data?.members ?? []} s={st.data} manage={manage} onDeleted={() => setSel(null)} /> : <Empty title="No roles yet" />}
    </div>
  );
}

function RoleDetail({ org, role, catalog, members, s, manage, onDeleted }: { org: Org; role: OrgRole; catalog: AbilityInfo[]; members: Member[]; s: Structure | null; manage: boolean; onDeleted(): void }) {
  const owner = role.templateKey === 'owner';
  const editable = manage && !owner;
  const has = new Set(owner ? catalog.map((a) => a.id) : role.abilities);
  const toggle = (id: string, on: boolean) => act(`/v1/orgs/${org.id}/roles/${role.id}`, { abilities: catalog.map((a) => a.id).filter((a) => (a === id ? on : has.has(a))) });
  const groups = [...new Set(catalog.map((a) => groupOf(a.id)))];
  const holders = members.filter((m) => m.roles?.some((g) => g.roleId === role.id));
  const dname = (id: string) => s?.departments.find((d) => d.id === id)?.name ?? 'a department';
  const scopeText = (g: RoleGrant) => (g.scope === 'org' ? 'Whole organization' : g.scope.map(dname).join(', '));
  return (
    <Card
      title={
        editable ? (
          <input className="input sm wk-role-name" defaultValue={role.name} onBlur={(e) => e.target.value.trim() && e.target.value !== role.name && act(`/v1/orgs/${org.id}/roles/${role.id}`, { name: e.target.value.trim() }, 'Renamed.')} />
        ) : (
          role.name
        )
      }
      actions={
        manage &&
        !role.template && (
          <button
            className="icon-btn sm"
            title="Delete this role"
            onClick={async () => {
              if ((await ask(`Delete ${role.name}?`, 'People who have it lose what it gives (anyone left with no role keeps Member). Join codes for it stop working.', [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Delete', danger: true, primary: true }])) !== 'yes') return;
              if (await act(`/v1/orgs/${org.id}/roles/${role.id}/delete`, {}, 'Deleted.')) onDeleted();
            }}
          >
            <Trash2 size={14} />
          </button>
        )
      }
    >
      {owner && <p className="muted af-small">Owners can do everything, always, for the whole organization.</p>}
      <div className="wk-abilities">
        {groups.map((g) => (
          <div key={g} className="wk-ab-group">
            <div className="wk-ab-head">{g}</div>
            {catalog
              .filter((a) => groupOf(a.id) === g)
              .map((a) => (
                <label key={a.id} className={`wk-check ${editable ? '' : 'wk-dim'}`} title={a.orgOnly ? 'Only counts when the role is given for the whole organization' : undefined}>
                  <input type="checkbox" checked={has.has(a.id)} disabled={!editable} onChange={(e) => toggle(a.id, e.target.checked)} />
                  <span>{a.label}</span>
                </label>
              ))}
          </div>
        ))}
      </div>
      <div className="wk-ab-head">People with this role</div>
      {!holders.length && <p className="muted af-small">Nobody yet.</p>}
      {holders.map((m) => {
        const g = m.roles!.find((x) => x.roleId === role.id)!;
        return (
          <div key={m.id} className="wk-row">
            <span className="wk-row-main">
              <span className="wk-row-title">{m.name}</span>
              <span className="wk-row-sub">{scopeText(g)}</span>
            </span>
            {can(org, 'roles.assign', m.departmentId) && !m.you && (
              <button className="icon-btn sm" title={`Take ${role.name} away from ${m.name}`} onClick={() => act(`/v1/orgs/${org.id}/members/${m.id}/roles/${role.id}/delete`, {}, 'Taken away.')}>
                <X size={14} />
              </button>
            )}
          </div>
        );
      })}
      {can(org, 'roles.assign') && <GiveRole org={org} role={role} members={members.filter((m) => !holders.includes(m))} s={s} />}
    </Card>
  );
}

/** Give the role to someone: for the whole organization, or for chosen departments (and the teams under them). */
function GiveRole({ org, role, members, s }: { org: Org; role: OrgRole; members: Member[]; s: Structure | null }) {
  const [who, setWho] = useState('');
  const [where, setWhere] = useState<'org' | 'depts'>('org');
  const [depts, setDepts] = useState<string[]>([]);
  const owner = role.templateKey === 'owner';
  const ready = who && (owner || where === 'org' || depts.length > 0);
  return (
    <div className="wk-give">
      <div className="wk-form-row">
        <select className="input sm wk-auto" value={who} onChange={(e) => setWho(e.target.value)}>
          <option value="">Give it to…</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        {!owner && (s?.departments.length ?? 0) > 0 && (
          <select className="input sm wk-auto" value={where} onChange={(e) => setWhere(e.target.value as 'org' | 'depts')}>
            <option value="org">For the whole organization</option>
            <option value="depts">For some departments</option>
          </select>
        )}
        <button
          className="btn sm primary"
          disabled={!ready}
          onClick={async () => {
            if (await act(`/v1/orgs/${org.id}/members/${who}/roles`, { roleId: role.id, scope: owner || where === 'org' ? 'org' : depts }, 'Given.')) {
              setWho('');
              setDepts([]);
            }
          }}
        >
          Give
        </button>
      </div>
      {where === 'depts' && !owner && (
        <div className="wk-tags">
          {s?.departments.map((d) => (
            <button key={d.id} className={`wk-chip ${depts.includes(d.id) ? 'on' : ''}`} onClick={() => setDepts(depts.includes(d.id) ? depts.filter((x) => x !== d.id) : [...depts, d.id])}>
              {d.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
