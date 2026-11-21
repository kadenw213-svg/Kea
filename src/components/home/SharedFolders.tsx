// Home → Create → Project → Shared work folders (Kea 0.99): every organization's shared folders you can see, a copy of
// any of them on this PC (opened as a project, with a new document or the folder itself), and a new one for your
// workplace. Organizations on servers without shared folders (older KeaS or Kea account server) aren't listed.
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { Users, FolderOpen, Plus, Eye, Pencil, ShieldCheck, FileText } from 'lucide-react';
import { api, type TeamFolderGroup, type TeamFolderHere } from '../../lib/api';
import { toast } from '../../store';
import { newFile } from '../../lib/open';
import { ACCESS_LABEL } from '../assistant/SharedFolder';

export const useSharedFolders = create<{ open: boolean }>(() => ({ open: false }));
const size = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 ** 2 ? `${Math.round(b / 1024 ** 2)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

export function SharedFoldersDialog() {
  const { open } = useSharedFolders();
  const [groups, setGroups] = useState<TeamFolderGroup[] | null>(null);
  const [error, setError] = useState('');
  const [making, setMaking] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () =>
    api.teamFolders
      .list()
      .then((g) => (setGroups(g), setError('')))
      .catch((e) => (setGroups([]), setError(String(e?.message || e).replace(/^Error: /, ''))));
  useEffect(() => {
    if (open) (setGroups(null), load());
  }, [open]);
  if (!open) return null;
  const close = () => (useSharedFolders.setState({ open: false }), setMaking(null), setName(''));
  const opened = (h: TeamFolderHere, then: 'doc' | null) => {
    toast(`${h.name} from ${h.orgName} is on this PC: ${h.root}`, 'success');
    if (then && h.access !== 'view') newFile(then, h.root);
    else api.openPath(h.root).catch(() => {});
    close();
  };
  const openOne = async (orgId: string, folderId: string, then: 'doc' | null) => {
    setBusy(true);
    try {
      opened(await api.teamFolders.open(orgId, folderId), then);
    } catch (e: any) {
      toast(String(e?.message || e).replace(/^Error: /, ''), 'error');
    } finally {
      setBusy(false);
    }
  };
  const make = async (orgId: string) => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      opened(await api.teamFolders.create(orgId, name.trim()), 'doc');
    } catch (e: any) {
      toast(String(e?.message || e).replace(/^Error: /, ''), 'error');
    } finally {
      setBusy(false);
    }
  };
  const Icon = { view: Eye, edit: Pencil, manage: ShieldCheck };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog shared-folders" role="dialog" aria-label="Shared work folders">
        <h2>Shared work folders</h2>
        <p>Folders your workplace shares. Kea keeps a copy on this PC up to date, and Claude can use their files when you work on them (unless whoever manages the folder turns that off).</p>
        {groups === null ? (
          <div className="spinner" />
        ) : !groups.length ? (
          <div className="sf-empty muted">{error || 'None of your organizations share folders yet. Sign in to your Kea account and join your workplace in Work first (its server needs KeaS 0.10 or later).'}</div>
        ) : (
          <div className="sf-groups">
            {groups.map((g) => (
              <section key={g.org.id} className="sf-group">
                <div className="sf-org">
                  <Users size={14} /> {g.org.name}
                  {g.quota && g.quota.limit > 0 && (
                    <span className="muted">
                      {' '}
                      · {size(g.quota.used)} of {size(g.quota.limit)} used
                    </span>
                  )}
                </div>
                {g.error && <div className="muted">{g.error}</div>}
                {g.folders.map((f) => {
                  const I = Icon[f.access];
                  return (
                    <div key={f.id} className="sf-row">
                      <FolderOpen size={15} />
                      <span className="sf-name">{f.name}</span>
                      <span className="muted sf-meta">
                        <I size={12} /> {ACCESS_LABEL[f.access]} · {f.fileCount} file{f.fileCount === 1 ? '' : 's'}
                        {f.here ? ' · on this PC' : ''}
                      </span>
                      {f.access !== 'view' && (
                        <button className="btn sm ghost" disabled={busy} onClick={() => openOne(g.org.id, f.id, 'doc')} title="Open it here and start a new document in it">
                          <FileText size={13} /> New document
                        </button>
                      )}
                      <button className="btn sm" disabled={busy} onClick={() => openOne(g.org.id, f.id, null)}>
                        {f.here ? 'Show' : 'Get a copy'}
                      </button>
                    </div>
                  );
                })}
                {!g.folders.length && !g.error && <div className="muted sf-none">No shared folders you can see yet.</div>}
                {g.canCreate &&
                  (making === g.org.id ? (
                    <div className="sf-row">
                      <input className="input sm" autoFocus value={name} placeholder="Front desk, Schedules, Training…" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && make(g.org.id)} />
                      <button className="btn sm primary" disabled={busy || !name.trim()} onClick={() => make(g.org.id)}>
                        Make it
                      </button>
                    </div>
                  ) : (
                    <button className="link-btn sm sf-new" onClick={() => (setMaking(g.org.id), setName(''))}>
                      <Plus size={13} /> New shared folder for {g.org.name}
                    </button>
                  ))}
              </section>
            ))}
          </div>
        )}
        <div className="dialog-actions">
          <button className="btn sm" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
