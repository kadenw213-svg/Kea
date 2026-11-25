// "From Google Drive…" in a context folder (Kea 0.108.1): the person's Drive, browsed in Kea. My Drive and its
// folders, Shared with me, Recent, or a search; tick files and Add. Docs, Sheets and Slides are added as live links
// (Claude reads them as they are now), other files are copied into the folder. Through the Drive connection
// (Settings → Google, electron/google.cjs list / copyInto).
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight, File as FileIcon, FileText, Folder, Loader2, Presentation, Search, Sheet as SheetIcon, X } from 'lucide-react';
import { api, DriveEntry } from '../../lib/api';

type View = 'my' | 'shared' | 'recent';
const VIEWS: [View, string][] = [
  ['my', 'My Drive'],
  ['shared', 'Shared with me'],
  ['recent', 'Recent']
];
const LIVE = new Set(['doc', 'sheet', 'slides']);

function Icon({ kind }: { kind: DriveEntry['kind'] }) {
  if (kind === 'folder') return <Folder size={15} />;
  if (kind === 'doc') return <FileText size={15} />;
  if (kind === 'sheet') return <SheetIcon size={15} />;
  if (kind === 'slides') return <Presentation size={15} />;
  return <FileIcon size={15} />;
}
const sizeOf = (n: number | null) => (n == null ? '' : n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const clean = (m: string) => m.replace(/^.*?\[\w+\]\s*/, '');

export interface DrivePicked {
  /** Docs, Sheets and Slides to link live. */
  links: { id: string; name: string; kind: 'doc' | 'sheet' | 'slides' }[];
  /** Files to copy into the folder. */
  copies: string[];
}

export function DriveBrowser({ folderName, canLink, onClose, onAdd }: { folderName: string; canLink: boolean; onClose(): void; onAdd(p: DrivePicked): Promise<void> }) {
  const [view, setView] = useState<View>('my');
  const [trail, setTrail] = useState<{ id: string; name: string }[]>([]);
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [files, setFiles] = useState<DriveEntry[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [picked, setPicked] = useState<Map<string, DriveEntry>>(new Map());
  const [snapshot, setSnapshot] = useState(false);
  const [busy, setBusy] = useState(false);
  const folderId = trail[trail.length - 1]?.id || '';

  const load = async (more?: string) => {
    if (!api.google.list) return setError('This copy of Kea can’t browse Google Drive. Update Kea.');
    setError('');
    if (!more) setFiles(null);
    try {
      const r = await api.google.list({ view, folderId, query: searched, ...(more ? { pageToken: more } : {}) });
      setFiles((f) => (more ? [...(f || []), ...r.files] : r.files));
      setNext(r.next);
    } catch (err: any) {
      const m = String(err?.message || err);
      setFiles([]);
      setError(/NO_ACCOUNT|Connect Google Drive/.test(m) ? 'NO_ACCOUNT' : clean(m));
    }
  };
  useEffect(() => {
    load();
  }, [view, folderId, searched]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const connect = async () => {
    setBusy(true);
    try {
      await api.google.connectAll();
      await load();
    } catch (err: any) {
      setError(clean(String(err?.message || err)));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (f: DriveEntry) => {
    const m = new Map(picked);
    m.has(f.id) ? m.delete(f.id) : m.set(f.id, f);
    setPicked(m);
  };
  const open = (f: DriveEntry) => {
    setSearched('');
    setQuery('');
    setTrail([...trail, { id: f.id, name: f.name }]);
  };
  const add = async () => {
    const list = [...picked.values()];
    const link = (f: DriveEntry) => canLink && !snapshot && LIVE.has(f.kind);
    setBusy(true);
    try {
      await onAdd({ links: list.filter(link).map((f) => ({ id: f.id, name: f.name, kind: f.kind as 'doc' | 'sheet' | 'slides' })), copies: list.filter((f) => !link(f)).map((f) => f.id) });
      onClose();
    } catch (err: any) {
      setError(clean(String(err?.message || err)));
    } finally {
      setBusy(false);
    }
  };
  const live = [...picked.values()].filter((f) => LIVE.has(f.kind)).length;

  return createPortal(
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog gd-dialog" role="dialog" aria-label="Add from Google Drive">
        <div className="gd-head">
          <b>Add from Google Drive</b>
          <span className="muted"> to {folderName}</span>
          <span className="cf-grow" />
          <button className="icon-btn sm" title="Close" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <div className="gd-bar">
          <div className="seg-mini">
            {VIEWS.map(([v, label]) => (
              <button key={v} className={view === v && !searched ? 'on' : ''} onClick={() => (setView(v), setTrail([]), setSearched(''), setQuery(''))}>
                {label}
              </button>
            ))}
          </div>
          <form
            className="gd-search"
            onSubmit={(e) => {
              e.preventDefault();
              setSearched(query.trim());
            }}
          >
            <Search size={13} />
            <input className="input sm" value={query} placeholder="Search your Drive" onChange={(e) => setQuery(e.target.value)} />
          </form>
        </div>
        {(trail.length > 0 || searched) && (
          <div className="gd-trail muted">
            {searched ? (
              <>Results for “{searched}”</>
            ) : (
              <>
                <button className="link-btn" onClick={() => setTrail([])}>
                  {VIEWS.find(([v]) => v === view)![1]}
                </button>
                {trail.map((t, i) => (
                  <span key={t.id}>
                    <ChevronRight size={12} />
                    <button className="link-btn" onClick={() => setTrail(trail.slice(0, i + 1))}>
                      {t.name}
                    </button>
                  </span>
                ))}
              </>
            )}
          </div>
        )}
        <div className="gd-list">
          {error === 'NO_ACCOUNT' ? (
            <div className="gd-empty">
              <span>Connect your Google account so Kea can show your Drive.</span>
              <button className="btn primary sm" disabled={busy} onClick={connect}>
                Connect Google
              </button>
            </div>
          ) : error ? (
            <div className="gd-empty gd-error">{error}</div>
          ) : files === null ? (
            <div className="gd-empty">
              <Loader2 size={16} className="spin" />
            </div>
          ) : !files.length ? (
            <div className="gd-empty muted">{searched ? 'Nothing in your Drive matches that.' : 'Nothing here.'}</div>
          ) : (
            files.map((f) => {
              const on = picked.has(f.id);
              const can = f.kind !== 'other-google';
              return (
                <div key={f.id} className={`gd-row ${on ? 'on' : ''} ${can ? '' : 'off'}`} onDoubleClick={() => f.kind === 'folder' && open(f)}>
                  {f.kind === 'folder' ? (
                    <span className="gd-tick-space" />
                  ) : (
                    <button className={`hub-tick ${on ? 'all' : 'none'}`} disabled={!can} onClick={() => toggle(f)} aria-label={`Tick ${f.name}`} title={can ? '' : 'Kea reads Google Docs, Sheets and Slides, and ordinary files'}>
                      {on && <Check size={12} />}
                    </button>
                  )}
                  <span className="gd-ic">
                    <Icon kind={f.kind} />
                  </span>
                  <button className="gd-name" disabled={!can} onClick={() => (f.kind === 'folder' ? open(f) : toggle(f))}>
                    {f.name}
                  </button>
                  <span className="muted gd-meta">{f.kind === 'folder' ? <ChevronRight size={14} /> : [LIVE.has(f.kind) ? 'live' : sizeOf(f.size), f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : ''].filter(Boolean).join(' · ')}</span>
                </div>
              );
            })
          )}
          {next && files && (
            <button className="btn sm gd-more" onClick={() => load(next)}>
              Show more
            </button>
          )}
        </div>
        <div className="gd-foot">
          <span className="muted small">
            {canLink && !snapshot ? 'Docs, Sheets and Slides stay live: Claude reads them as they are now. Other files are copied into the folder.' : 'Everything is copied into the folder (Docs, Sheets and Slides as Word, Excel and PowerPoint files).'}
          </span>
          <span className="cf-grow" />
          {canLink && live > 0 && (
            <label className="cf-copy" title="Copy them in as they are now instead of reading them live">
              <input type="checkbox" checked={snapshot} onChange={(e) => setSnapshot(e.target.checked)} /> Copy them instead
            </label>
          )}
          <button className="btn primary sm" disabled={!picked.size || busy} onClick={add}>
            {busy ? <Loader2 size={13} className="spin" /> : null} Add {picked.size || ''}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
