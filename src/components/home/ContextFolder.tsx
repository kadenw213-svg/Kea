// A context folder's contents, managed in Kea (Kea 0.101.2): no File Explorer needed. Add files from this PC, Kea
// cloud or Google Drive (copied into the folder, or linked where they are and read live), drop files on the window,
// make a new document or sheet in it, choose which files Claude uses, and take files out (to the Recycle Bin).
// Opened from Home's Ask Claude bar (Manage files) and from the project strip in the Claude panel.
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { FileText, Sheet as SheetIcon, Image as ImageIcon, Film, Music, File as FileIcon, Link2, Cloud, HardDrive, Trash2, X, FilePlus2, Users, Plus, Share2 } from 'lucide-react';
import { api } from '../../lib/api';
import { toast } from '../../store';
import { findProject, kindWord, projectFiles, saveProject, useProjects, type Project } from '../../lib/projects';
import { friendlyPath, useKeaCloud } from '../../lib/keaCloud';
import { newFile } from '../../lib/open';
import { MenuButton } from '../Popover';
import { SharePanel } from './SharePanel';

const useManager = create<{ dir: string | null; share?: boolean }>(() => ({ dir: null }));
/** Open the manager for a context folder (`share`: with its Share panel open). */
export const manageContextFolder = (dir: string, opts?: { share?: boolean }) => useManager.setState({ dir, share: !!opts?.share });

type F = Awaited<ReturnType<typeof projectFiles>>[number];

function iconFor(rel: string) {
  if (rel.startsWith('Google: ')) return <Link2 size={15} />;
  const k = kindWord(rel);
  if (k === 'image') return <ImageIcon size={15} />;
  if (k === 'video') return <Film size={15} />;
  if (k === 'audio') return <Music size={15} />;
  if (/\.(xlsx|xls|csv|tsv)$/i.test(rel)) return <SheetIcon size={15} />;
  if (k === 'file') return <FileIcon size={15} />;
  return <FileText size={15} />;
}

export function ContextFolderDialog() {
  const dir = useManager((s) => s.dir);
  useProjects((s) => s.version);
  const [p, setP] = useState<Project | null>(null);
  const [files, setFiles] = useState<F[] | null>(null);
  const [copy, setCopy] = useState(true);
  const [busy, setBusy] = useState(false);
  const [drop, setDrop] = useState(false);
  const [gLink, setGLink] = useState('');
  const cloudRoot = useKeaCloud((s) => s.status?.root);
  const [tick, setTick] = useState(0);
  const [sharing, setSharing] = useState(false);
  const refresh = () => setTick((t) => t + 1);
  useEffect(() => setSharing(!!useManager.getState().share), [dir]);

  useEffect(() => {
    if (!dir) return setP(null);
    let live = true;
    findProject(dir).then(async (found) => {
      if (!live) return;
      // Shared, so it moved: manage the copy kept in Kea cloud.
      if (found?.movedTo && found.dir === dir) return manageContextFolder(found.movedTo);
      setP(found);
      setFiles(found ? await projectFiles(found).catch(() => []) : []);
    });
    return () => {
      live = false;
    };
  }, [dir, tick, useProjects.getState().version]);

  if (!dir) return null;
  const close = () => (useManager.setState({ dir: null }), setFiles(null), setGLink(''), setSharing(false));
  if (!p)
    return (
      <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
        <div className="dialog cf-dialog">
          <div className="muted">Opening…</div>
        </div>
      </div>
    );

  const save = async (next: Project) => {
    const saved = await saveProject(next);
    setP(saved);
    refresh();
  };
  const addPaths = async (paths: string[]) => {
    if (!paths.length) return;
    setBusy(true);
    try {
      if (copy || p.shared) {
        const names = await api.context.copyIn(p.dir, paths);
        // A shared folder: what's added goes up for everyone.
        if (p.shared) for (const n of names) await api.teamFolders.upload(`${p.dir}${p.dir.includes('\\') ? '\\' : '/'}${n}`).catch((err: any) => toast(String(err?.message || err), 'error'));
        toast(names.length === 1 ? `Added ${names[0]}` : `Added ${names.length} files`, 'success');
      } else {
        const refs = [...(p.refs || [])];
        for (const path of paths) if (!refs.some((r) => r.path.toLowerCase() === path.toLowerCase())) refs.push({ path, name: path.split(/[\\/]/).pop() || path });
        await saveProject({ ...p, refs });
        toast(paths.length === 1 ? 'Linked 1 file' : `Linked ${paths.length} files`, 'success');
      }
      refresh();
    } catch (err: any) {
      toast(String(err?.message || err), 'error');
    } finally {
      setBusy(false);
    }
  };
  const pick = async (from?: string) => addPaths(await api.context.pickFiles({ title: `Add files to ${p.name}`, from }));
  const addGoogle = async () => {
    setBusy(true);
    try {
      const g = await api.google.linkInfo(gLink.trim());
      await save({ ...p, links: [...(p.links || []).filter((l) => l.id !== g.id), g] });
      setGLink('');
      toast(`Added ${g.name}`, 'success');
    } catch (err: any) {
      const m = String(err?.message || err);
      toast(/NO_ACCOUNT|Connect Google Drive/.test(m) ? 'Connect Google Drive first (Settings → Google), then add the link again.' : m.replace(/^.*?\[\w+\]\s*/, ''), 'error');
    } finally {
      setBusy(false);
    }
  };
  const remove = async (f: F) => {
    try {
      if (f.rel.startsWith('Google: ')) await save({ ...p, links: (p.links || []).filter((l) => `Google: ${l.name}` !== f.rel), exclude: p.exclude.filter((x) => x !== f.rel) });
      else if (f.rel.startsWith('Linked: ')) await save({ ...p, refs: (p.refs || []).filter((r) => `Linked: ${r.name}` !== f.rel), exclude: p.exclude.filter((x) => x !== f.rel) });
      else {
        if (p.shared && p.shared.access === 'view') return toast(`${p.shared.orgName} lets you view this folder, not change it.`, 'error');
        if (p.shared) {
          const r = await api.contextShare.removeFile(f.path);
          if (!r.ok) throw new Error(r.error);
          toast(`${f.rel} was removed for everyone (it can be restored for 30 days).`);
        } else {
          await api.context.trash(f.path);
          toast(`${f.rel} went to the Recycle Bin.`);
        }
        refresh();
      }
    } catch (err: any) {
      toast(String(err?.message || err), 'error');
    }
  };
  const toggle = (f: F) => save({ ...p, exclude: f.used ? [...p.exclude, f.rel] : p.exclude.filter((x) => x !== f.rel) });
  const where = friendlyPath(p.dir);
  const used = (files || []).filter((f) => f.used).length;

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div
        className={`dialog cf-dialog ${drop ? 'drop' : ''}`}
        role="dialog"
        aria-label={p.name}
        onDragOver={(e) => {
          if (!Array.from(e.dataTransfer.types).includes('Files')) return;
          e.preventDefault();
          e.stopPropagation();
          setDrop(true);
        }}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDrop(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          (e.nativeEvent as any).keaTaken = true;
          setDrop(false);
          addPaths(Array.from(e.dataTransfer.files).map((f) => api.getPathForFile(f)).filter(Boolean));
        }}
      >
        <div className="cf-head">
          <div>
            <input className="cf-name" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} onBlur={() => p.name.trim() && save(p)} title="Rename" />
            <div className="cf-where muted" title={p.dir}>
              {where.startsWith('Kea cloud') ? <Cloud size={12} /> : <HardDrive size={12} />} {where}
            </div>
          </div>
          <div className="cf-head-acts">
            {(!p.shared || p.shared.personal) && (
              <button className={`btn sm ${sharing ? 'on' : ''}`} onClick={() => setSharing(!sharing)} title="Let other Kea accounts use this folder">
                <Share2 size={13} /> {p.shared?.personal ? 'Shared' : 'Share'}
              </button>
            )}
            <button className="icon-btn" title="Close" onClick={close}>
              <X size={16} />
            </button>
          </div>
        </div>
        {sharing && <SharePanel p={p} onMoved={(root) => (setSharing(true), manageContextFolder(root))} />}

        <div className="cf-add">
          <MenuButton
            button={() => (
              <button className="btn primary sm" disabled={busy}>
                <Plus size={14} /> Add files
              </button>
            )}
          >
            {(done) => (
              <>
                <button className="menu-item" onClick={() => (done(), pick())}>
                  <HardDrive size={16} /> From this PC…
                </button>
                {cloudRoot && (
                  <button className="menu-item" onClick={() => (done(), pick(cloudRoot))}>
                    <Cloud size={16} /> From Kea cloud…
                  </button>
                )}
                <div className="menu-sep" />
                <button className="menu-item" onClick={() => (done(), newFile('doc', p.dir), close())}>
                  <FilePlus2 size={16} /> New document in it
                </button>
                <button className="menu-item" onClick={() => (done(), newFile('sheet', p.dir), close())}>
                  <SheetIcon size={16} /> New spreadsheet in it
                </button>
              </>
            )}
          </MenuButton>
          {!p.shared && <label className="cf-copy" title="Copied: the folder keeps its own copy (it travels with the folder, in Kea cloud too). Linked: Kea reads the original where it is, as it changes.">
            <input type="checkbox" checked={copy} onChange={(e) => setCopy(e.target.checked)} /> Copy into the folder
          </label>}
          <span className="cf-grow" />
          {!p.shared && <div className="cf-google">
            <input className="input sm" value={gLink} placeholder="Google Doc or Sheet link" onChange={(e) => setGLink(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && gLink.trim() && addGoogle()} />
            <button className="btn sm" disabled={busy || !gLink.trim()} onClick={addGoogle}>
              <Link2 size={13} /> Add
            </button>
          </div>}
        </div>

        <div className="cf-list">
          {files === null ? (
            <div className="muted cf-empty">Loading…</div>
          ) : files.length === 0 ? (
            <div className="cf-empty">
              <b>No files yet.</b>
              <span className="muted">Add files, paste a Google link, or drop files here. Any kind works: sheets, documents, PDFs, slides, photos, video and audio.</span>
            </div>
          ) : (
            files.map((f) => (
              <div key={f.rel} className={`cf-row ${f.used ? '' : 'off'}`}>
                <span className="cf-ic">{iconFor(f.rel)}</span>
                <span className="cf-file" title={f.path.startsWith('google:') ? f.rel : f.path}>
                  {f.rel.replace(/^(Google|Linked): /, '')}
                </span>
                <span className="cf-src muted">{f.rel.startsWith('Google: ') ? 'Google' : f.rel.startsWith('Linked: ') ? 'Linked' : ''}</span>
                <label className="cf-use" title={f.locked ? `${p.shared?.orgName} doesn’t let Claude use this file` : 'Claude may read this file'}>
                  <input type="checkbox" checked={f.used} disabled={!!f.locked} onChange={() => toggle(f)} /> Claude
                </label>
                <button className="icon-btn sm" title={f.rel.startsWith('Google: ') || f.rel.startsWith('Linked: ') ? 'Remove the link (the file stays where it is)' : 'Remove (to the Recycle Bin)'} onClick={() => remove(f)}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="cf-foot">
          <span className="muted">
            {files ? `${files.length} ${files.length === 1 ? 'file' : 'files'} · Claude uses ${used}` : ''}
          </span>
          {p.kind === 'work' && (
            <label className="cf-copy" title="Claude can find people’s emails and phone numbers in your Google Contacts (read-only)">
              <input
                type="checkbox"
                checked={!!p.contacts}
                onChange={async (e) => {
                  const on = e.target.checked;
                  try {
                    if (on && !(await api.contacts.status()).connected) await api.google.connectAll();
                    await save({ ...p, contacts: on });
                  } catch (err: any) {
                    toast(String(err?.message || err).replace(/^.*?\[\w+\]\s*/, ''), 'error');
                  }
                }}
              />{' '}
              <Users size={12} /> Look people up in Google Contacts
            </label>
          )}
          <button className="btn sm" onClick={close}>
            Done
          </button>
        </div>
        {drop && <div className="cf-drop">Drop to {copy ? 'add to' : 'link in'} {p.name}</div>}
      </div>
    </div>
  );
}

// For Kea's own end-to-end checks (the screenshot harness).
(window as any).__keaContext = { manageContextFolder };
