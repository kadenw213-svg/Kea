// Sharing a context folder with other Kea accounts (Kea 0.102), inside the folder's files window. The first share
// moves the folder to Kea cloud (electron/contextShares.cjs), so the warning says exactly what will happen first.
import { useEffect, useState } from 'react';
import { Cloud, Trash2, UserPlus } from 'lucide-react';
import { api, type SharePerson } from '../../lib/api';
import { forgetProject, loadProject, rememberProject, type Project } from '../../lib/projects';
import { useSettings } from '../../lib/settings';
import { toast } from '../../store';

const size = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${Math.round(b / 1e6)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

export function SharePanel({ p, onMoved }: { p: Project; onMoved: (root: string) => void }) {
  const [avail, setAvail] = useState<boolean | null>(null);
  const [pre, setPre] = useState<{ shared: boolean; files: number; bytes: number; refs: number; google: string[] } | null>(null);
  const [people, setPeople] = useState<SharePerson[]>([]);
  const [ids, setIds] = useState<{ orgId: string; folderId: string } | null>(null);
  const [email, setEmail] = useState('');
  const [access, setAccess] = useState<'view' | 'edit'>('edit');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');

  useEffect(() => {
    api.contextShare.available().then((r) => setAvail(r.ok ? r.value : false));
    api.contextShare.preview(p.dir).then((r) => r.ok && setPre(r.value));
    api.contextShare.status(p.dir).then((r) => {
      if (r.ok && r.value.shared) {
        setPeople(r.value.people);
        setIds({ orgId: r.value.orgId, folderId: r.value.folderId });
      }
    });
    return api.contextShare.onProgress((x) => setProgress(`${x.msg} (${x.n} of ${x.total})`));
  }, [p.dir]);

  if (avail === false)
    return (
      <div className="cf-share">
        <p className="muted">Sign in to your Kea account to share this folder with other people. (If you are signed in, your Kea account server needs an update first.)</p>
      </div>
    );
  if (p.shared && !p.shared.personal) return null;

  const share = async () => {
    const e = email.trim();
    if (!e) return;
    setBusy(true);
    setProgress('');
    try {
      const r = await api.contextShare.share({ dir: p.dir, email: e, access });
      if (!r.ok) throw new Error(r.error);
      setPeople(r.value.people);
      setIds({ orgId: r.value.orgId, folderId: r.value.folderId });
      setEmail('');
      if (r.value.moved) {
        // The folder lives in Kea cloud now: Home's bar and the files window use the copy.
        const moved = await loadProject(r.value.root);
        if (moved) rememberProject(moved, true);
        forgetProject(p.dir);
        if (useSettings.getState().values['home.askFolder'] === p.dir) useSettings.getState().set({ 'home.askFolder': r.value.root });
        if (r.value.skipped.length) toast(`Couldn’t copy ${r.value.skipped.join(', ')}. Add them again in the shared folder.`, 'error');
        onMoved(r.value.root);
      }
      toast(`Shared with ${e}`, 'success');
    } catch (err: any) {
      toast(String(err?.message || err), 'error');
    } finally {
      setBusy(false);
      setProgress('');
    }
  };
  const remove = async (person: SharePerson) => {
    if (!ids) return;
    const r = await api.contextShare.unshare({ ...ids, accountId: person.id });
    if (r.ok) setPeople(r.value);
    else toast(r.error, 'error');
  };
  const first = !pre?.shared && !p.shared;

  return (
    <div className="cf-share">
      {first && pre && (
        <div className="cf-share-warn">
          <Cloud size={16} />
          <div>
            <b>Sharing moves this folder to Kea cloud</b>, so everyone you share it with has the same, current files.
            <ul>
              {pre.files > 0 && (
                <li>
                  Its {pre.files} {pre.files === 1 ? 'file' : 'files'} ({size(pre.bytes)}) are uploaded and count against your Kea storage.
                </li>
              )}
              {pre.refs > 0 && <li>{pre.refs} linked {pre.refs === 1 ? 'file is' : 'files are'} copied in (the originals stay where they are).</li>}
              {pre.google.length > 0 && (
                <li>
                  Google {pre.google.length === 1 ? 'file' : 'files'} {pre.google.join(', ')} {pre.google.length === 1 ? 'becomes an Office copy' : 'become Office copies'} kept in Kea. From then on, edit {pre.google.length === 1 ? 'that copy' : 'those copies'} in Kea: changes made in Google Docs or Sheets won’t reach the people you share with.
                </li>
              )}
              <li>The folder on this PC stays as it is, as a backup. Kea uses the shared copy from now on.</li>
            </ul>
          </div>
        </div>
      )}
      <div className="cf-share-add">
        <input className="input sm" type="email" value={email} placeholder="Their Kea account email" onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && share()} />
        <select className="select sm" value={access} onChange={(e) => setAccess(e.target.value as 'view' | 'edit')}>
          <option value="edit">Can edit</option>
          <option value="view">Can view</option>
        </select>
        <button className="btn primary sm" disabled={busy || !email.trim()} onClick={share}>
          <UserPlus size={13} /> {first ? 'Move to Kea cloud and share' : 'Share'}
        </button>
      </div>
      {progress && <div className="muted cf-share-progress">{progress}</div>}
      {people.length > 0 && (
        <div className="cf-share-people">
          {people.map((x) => (
            <div key={x.id} className="cf-share-person">
              <span>{x.name || x.email}</span>
              <span className="muted">{x.name ? x.email : ''}</span>
              <span className="muted">{x.access === 'manage' ? 'Owner' : x.access === 'edit' ? 'Can edit' : 'Can view'}</span>
              {x.access !== 'manage' && (
                <button className="icon-btn sm" title="Stop sharing with them" onClick={() => remove(x)}>
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
