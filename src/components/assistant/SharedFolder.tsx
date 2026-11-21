// A shared work folder (Kea 0.99) in the project panel: who shared it and what you can do, whether this PC's copy is
// up to date, and (for people who manage it) Share… and whether Claude may use its files. The files and their Claude
// switches stay in ProjectChip; here is the folder as a whole, and the Share dialog.
import { useEffect, useState } from 'react';
import { Users, RefreshCw, Share2, Eye, Pencil, ShieldCheck, X, Plus } from 'lucide-react';
import { api, type TeamAccess, type TeamFolderGrant, type TeamFolderHere } from '../../lib/api';
import { toast } from '../../store';
import { findProject, useProjects, type Project } from '../../lib/projects';

export const ACCESS_LABEL: Record<TeamAccess, string> = { view: 'Can view', edit: 'Can edit', manage: 'Manages' };
const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};
const projectFileOf = (p: Project) => `${p.dir}${p.dir.includes('\\') ? '\\' : '/'}.kea-project.json`;

/** Re-read a project after the main process rewrote its project file (a sync, a Claude setting). */
export async function reloadProject(dir: string) {
  const p = await findProject(dir);
  useProjects.setState((s) => ({ byDir: Object.fromEntries(Object.entries(s.byDir).map(([d, v]) => [d, v && v.dir === dir ? p : v])), version: s.version + 1 }));
}

export function SharedFolderPanel({ p }: { p: Project }) {
  const s = p.shared!;
  const [here, setHere] = useState<TeamFolderHere | null>(null);
  const [busy, setBusy] = useState(false);
  const [sharing, setSharing] = useState(false);
  const load = () =>
    api.teamFolders
      .whereIs(projectFileOf(p))
      .then(setHere)
      .catch(() => setHere(null));
  useEffect(() => {
    load();
  }, [p.dir]);
  const syncNow = async () => {
    setBusy(true);
    try {
      await api.teamFolders.syncNow();
      await load();
      await reloadProject(p.dir);
    } catch (e: any) {
      toast(String(e?.message || e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const setClaude = async (on: boolean) => {
    setBusy(true);
    try {
      await api.teamFolders.update(s.orgId, s.folderId, { claude: on });
      await api.teamFolders.syncNow();
      await reloadProject(p.dir);
      toast(on ? `Claude may use the files in ${s.folderName || p.name}.` : `Claude won’t use the files in ${s.folderName || p.name} (for everyone).`, 'success');
    } catch (e: any) {
      toast(String(e?.message || e), 'error');
    } finally {
      setBusy(false);
    }
  };
  const Icon = s.access === 'view' ? Eye : s.access === 'edit' ? Pencil : ShieldCheck;
  return (
    <div className="as-shared">
      <div className="as-shared-row">
        <Users size={13} />
        <span>
          Shared by <b>{s.orgName}</b>
        </span>
        <span className="as-shared-access">
          <Icon size={12} /> {ACCESS_LABEL[s.access]}
        </span>
      </div>
      <div className="as-shared-row muted">
        {!here ? 'Not checked yet: use Check for changes.' : here.lastError ? here.lastError : here.lastSync ? `Up to date · checked ${ago(here.lastSync)}` : 'Checking for the first time…'}
        <span className="grow" />
        <button className="icon-btn sm" title="Check for changes now" disabled={busy} onClick={syncNow}>
          <RefreshCw size={13} className={busy ? 'spin' : ''} />
        </button>
      </div>
      {s.access === 'view' && <div className="as-shared-note">View only: changes you make here aren’t shared. Use Save as to keep your own copy.</div>}
      {s.access === 'manage' && (
        <div className="as-shared-row">
          <label className="as-project-file" title="For everyone in the organization: whether Claude may read this folder’s files. Each file can be set on its own below.">
            <input type="checkbox" disabled={busy} checked={s.claude} onChange={(e) => setClaude(e.target.checked)} />
            <span>Claude may use this folder’s files</span>
          </label>
          <span className="grow" />
          <button className="btn sm" onClick={() => setSharing(true)}>
            <Share2 size={13} /> Share…
          </button>
        </div>
      )}
      {sharing && <ShareDialog orgId={s.orgId} folderId={s.folderId} name={s.folderName || p.name} orgName={s.orgName} onClose={() => setSharing(false)} />}
    </div>
  );
}

type Row = TeamFolderGrant & { name: string; member?: boolean };

/** Who has what: people, roles and "everyone in <Org>", each View, Edit or Manage. */
export function ShareDialog({ orgId, folderId, name, orgName, onClose }: { orgId: string; folderId: string; name: string; orgName: string; onClose(): void }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [always, setAlways] = useState<{ owners: { name: string }[]; roles: { name: string }[] }>({ owners: [], roles: [] });
  const [people, setPeople] = useState<{ members: { id: string; name: string; you: boolean }[]; roles: { id: string; name: string }[] }>({ members: [], roles: [] });
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.teamFolders
      .access(orgId, folderId)
      .then((a) => {
        setRows(a.grants.map((g) => ({ kind: g.kind, id: g.id ?? null, access: g.access, name: g.kind === 'org' ? `Everyone in ${orgName}` : g.name, member: g.member })));
        setAlways(a.alwaysManage);
      })
      .catch((e) => (toast(String(e?.message || e), 'error'), onClose()));
    api.teamFolders.people(orgId).then(setPeople).catch(() => {});
  }, [orgId, folderId]);
  const has = (kind: string, id: string | null) => (rows || []).some((r) => r.kind === kind && (r.id ?? null) === id);
  const add = () => {
    if (!pick) return;
    const [kind, id] = pick.split(':');
    if (kind === 'org') !has('org', null) && setRows([...(rows || []), { kind: 'org', id: null, access: 'view', name: `Everyone in ${orgName}` }]);
    else {
      const n = kind === 'role' ? people.roles.find((r) => r.id === id)?.name : people.members.find((m) => m.id === id)?.name;
      if (!has(kind, id)) setRows([...(rows || []), { kind: kind as 'account' | 'role', id, access: 'view', name: kind === 'role' ? `${n} (role)` : n || 'Someone' }]);
    }
    setPick('');
  };
  const save = async () => {
    if (!rows) return;
    setBusy(true);
    try {
      await api.teamFolders.access(orgId, folderId, rows.map(({ kind, id, access }) => ({ kind, id, access })));
      toast(`Sharing for ${name} saved.`, 'success');
      onClose();
    } catch (e: any) {
      toast(String(e?.message || e).replace(/^Error: /, ''), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog share-dialog" role="dialog" aria-label={`Share ${name}`}>
        <h2>Share “{name}”</h2>
        <p>Everyone you add gets a copy of this folder in Kea that stays up to date. People who can edit can send their changes back; people who manage it can also change who has access and what Claude may use.</p>
        {!rows ? (
          <div className="spinner" />
        ) : (
          <div className="share-rows">
            {rows.map((r, i) => (
              <div key={`${r.kind}:${r.id}`} className="share-row">
                <span className="share-name">
                  {r.name}
                  {r.member === false && <span className="muted"> · left the organization</span>}
                </span>
                <select className="select" value={r.access} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, access: e.target.value as TeamAccess } : x)))}>
                  <option value="view">Can view</option>
                  <option value="edit">Can edit</option>
                  <option value="manage">Manages</option>
                </select>
                <button className="icon-btn sm" title="Remove" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                  <X size={14} />
                </button>
              </div>
            ))}
            <div className="share-row">
              <select className="select share-pick" value={pick} onChange={(e) => setPick(e.target.value)}>
                <option value="">Add a person, a role or everyone…</option>
                {!has('org', null) && <option value="org:">Everyone in {orgName}</option>}
                {people.roles.filter((r) => !has('role', r.id)).length > 0 && (
                  <optgroup label="Roles">
                    {people.roles
                      .filter((r) => !has('role', r.id))
                      .map((r) => (
                        <option key={r.id} value={`role:${r.id}`}>
                          {r.name}
                        </option>
                      ))}
                  </optgroup>
                )}
                <optgroup label="People">
                  {people.members
                    .filter((m) => !has('account', m.id))
                    .map((m) => (
                      <option key={m.id} value={`account:${m.id}`}>
                        {m.name}
                        {m.you ? ' (you)' : ''}
                      </option>
                    ))}
                </optgroup>
              </select>
              <button className="btn sm" disabled={!pick} onClick={add}>
                <Plus size={13} /> Add
              </button>
            </div>
            {(always.owners.length > 0 || always.roles.length > 0) && (
              <div className="muted share-always">Always manage it: {[...always.owners.map((o) => o.name), ...always.roles.map((r) => `${r.name} (role)`)].join(', ')}.</div>
            )}
          </div>
        )}
        <div className="dialog-actions">
          <button className="btn sm" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary sm" disabled={busy || !rows} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
