import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SupportLink } from './scholar/HubAccount';
import {
  FileText,
  FolderOpen,
  Search,
  X,
  FolderSearch,
  MoreVertical,
  Clock,
  Monitor,
  Download,
  Folder,
  FolderPlus,
  Plus,
  LayoutGrid,
  List,
  ArrowUpDown,
  ChevronRight,
  Pencil,
  Copy,
  Sun,
  Moon,
  Check,
  Loader2,
  ExternalLink,
} from 'lucide-react';
import { api, DirEntry, DriveInfo, FileMeta, HomeSettings, KeaCloudFileState, KnownFolder } from '../lib/api';
import { openPaths } from '../lib/open';
import { FileIcon } from './FileIcon';
import { timeAgo, formatBytes } from '../lib/util';
import { toast, prompt, ask } from '../store';
import { MenuButton } from './Popover';
import { kindFor, extOf } from '../lib/fileTypes';
import { Preview } from './home/Preview';
import { ConnectDrives } from './home/ConnectDrives';
import { DriveLogo } from './home/DriveLogo';
import { TemplateGallery } from './home/Templates';
import { Dashboard } from './home/Dashboard';
import { CreateBar } from './home/Create';
import { KeaCloudHeader, KeaCloudMark } from './home/KeaCloud';
import { Trash2, Upload, AlertTriangle, CloudUpload, HardDrive } from 'lucide-react';
import { useSetting } from '../lib/settings';
import { useAreas } from '../lib/areas';
import { cloudUsable, inKeaCloud, useKeaCloud, watchKeaCloud, friendlyPath, folderLabel } from '../lib/keaCloud';

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/** A file's Kea Cloud state, when it isn't simply up to date. */
function SyncMark({ state }: { state?: KeaCloudFileState }) {
  if (!state || state === 'synced') return null;
  if (state === 'pending')
    return (
      <span className="sync-mark" title="Waiting to sync">
        <CloudUpload size={13} />
      </span>
    );
  if (state === 'full')
    return (
      <span className="sync-mark bad" title="Not synced: your Kea storage is full">
        <AlertTriangle size={13} />
      </span>
    );
  return (
    <span className="sync-mark" title="Kept on this PC only (too big, or a name Kea storage can’t hold)">
      <HardDrive size={13} />
    </span>
  );
}

interface Item extends Partial<DirEntry> {
  path: string;
  name: string;
  openedAt?: number;
}

interface Source {
  id: string;
  label: string;
  path?: string;
  icon: React.ReactNode;
  cloud?: string;
  removable?: boolean;
}

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'doc', label: 'Docs' },
  { id: 'sheet', label: 'Sheets' },
  { id: 'slides', label: 'Slides' },
  { id: 'pdf', label: 'PDFs' },
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Video' }
] as const;
type FilterId = (typeof FILTERS)[number]['id'];

const GOOGLE_EXT: Record<string, string> = { gdoc: 'doc', gsheet: 'sheet', gslides: 'slides' };
const kindOf = (name: string) => GOOGLE_EXT[extOf(name)] || kindFor(name);
const sep = (p: string) => (p.includes('\\') ? '\\' : '/');
const under = (child: string, root: string) => {
  const c = child.toLowerCase();
  const r = root.toLowerCase().replace(/[\\/]+$/, '');
  return c === r || c.startsWith(r + '\\') || c.startsWith(r + '/');
};

export function HomeScreen({ visible }: { visible: boolean }) {
  const [settings, setSettings] = useState<HomeSettings>({});
  const [known, setKnown] = useState<KnownFolder[]>([]);
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [meta, setMeta] = useState<Record<string, FileMeta>>({});
  const [sourceId, setSourceId] = useState('recent');
  const [subPath, setSubPath] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchHits, setSearchHits] = useState<Item[] | null>(null);
  const [filter, setFilter] = useState<FilterId>('all');
  const [showDrives, setShowDrives] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [syncStates, setSyncStates] = useState<Record<string, KeaCloudFileState>>({});
  const cloud = useKeaCloud((s) => s.status);
  const cloudOn = useSetting<boolean>('keaCloud.enabled') !== false && useSetting<boolean>('keaCloud.showOnHome') !== false;
  const badges = useSetting<boolean>('keaCloud.fileBadges') !== false;
  const loadSeq = useRef(0);
  const showStart = useSetting<boolean>('home.showStart');
  const areas = useAreas();
  const showScholar = areas.includes('school');
  const showDocs = areas.includes('documents');
  const showTools = useSetting<boolean>('home.showTools');
  const showGreeting = useSetting<boolean>('home.greeting');
  const showPreviews = useSetting<boolean>('home.previews');
  const cardSize = useSetting<string>('home.cardSize');
  const showDesc = useSetting<boolean>('home.descriptions');
  const previewOnline = useSetting<boolean>('home.previewOnline');
  const allTypes = useSetting<boolean>('home.showAllTypes');
  const hidden = useSetting<boolean>('home.showHidden');
  const userName = useSetting<string>('user.name');

  const view = settings.view || 'grid';
  const tone = settings.tone || 'dark';
  const sort = settings.sort || 'recent';
  const saveSettings = (patch: HomeSettings) => {
    setSettings((s) => ({ ...s, ...patch }));
    api.setHomeSettings(patch);
  };

  const refreshDrives = useCallback(() => api.detectDrives().then(setDrives), []);

  useEffect(() => {
    api.homeSettings().then((s) => {
      setSettings(s);
      if (s.source) setSourceId(s.source);
    });
    api.knownFolders().then(setKnown);
    api.getMeta().then(setMeta);
    refreshDrives();
    const onFocus = () => refreshDrives();
    window.addEventListener('focus', onFocus);
    const unwatch = watchKeaCloud();
    return () => (window.removeEventListener('focus', onFocus), unwatch());
  }, []);

  const sources = useMemo<Source[]>(() => {
    const icon = (id: string) => (id === 'desktop' ? <Monitor size={17} /> : id === 'downloads' ? <Download size={17} /> : <FileText size={17} />);
    const list: Source[] = [{ id: 'recent', label: 'Recent', icon: <Clock size={17} /> }];
    for (const k of known) list.push({ id: k.id, label: k.label, path: k.path, icon: icon(k.id) });
    for (const f of settings.folders || []) list.push({ id: 'folder:' + f, label: f.split(/[\\/]/).filter(Boolean).pop() || f, path: f, icon: <Folder size={17} />, removable: true });
    // Kea Cloud: the person's Kea storage, first among the cloud drives.
    if (cloudOn && cloud) list.push({ id: 'keacloud', label: cloud.signedIn ? 'Kea Cloud' : 'Kea Cloud · Not online', path: cloud.root, icon: <KeaCloudMark />, cloud: 'kea' });
    for (const d of drives)
      for (const a of d.accounts)
        list.push({ id: `${d.id}:${a.path}`, label: d.accounts.length > 1 || a.label !== d.label ? `${d.label === a.label ? '' : d.label + ' · '}${a.label}` : d.label, path: a.path, icon: <DriveLogo id={d.id} size={17} />, cloud: d.id });
    return list;
  }, [known, drives, settings.folders, cloudOn, cloud?.root, cloud?.signedIn]);

  const source = sources.find((s) => s.id === sourceId) || sources[0];
  const isCloud = source.id === 'keacloud';
  const cloudLocked = isCloud && !cloudUsable(cloud);
  const dir = source.id === 'recent' ? null : subPath || source.path!;
  // Is this folder synced by a cloud drive? (Desktop/Documents often are, through OneDrive.)
  const cloudOf = (p: string) => {
    for (const d of drives) for (const a of d.accounts) if (under(p, a.path)) return d.id;
    return undefined;
  };

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setError(null);
    setLoading(true);
    try {
      let next: Item[];
      if (cloudLocked) next = [];
      else if (!dir) {
        const recent = await api.getRecent();
        const stats = await api.statMany(recent.map((r) => r.path));
        next = recent.map((r, i) => ({ ...r, size: stats[i]?.size, mtime: stats[i]?.mtime, missing: !stats[i]?.exists }) as Item).filter((r: any) => !r.missing);
      } else {
        const cloud = cloudOf(dir);
        next = await api.listDir(dir, { cloud: !!cloud && !previewOnline, allOnline: cloud === 'gdrive', allTypes, hidden });
      }
      if (seq === loadSeq.current) setItems(next);
    } catch (e: any) {
      if (seq === loadSeq.current) {
        setItems([]);
        setError(String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      }
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [dir, drives, previewOnline, allTypes, hidden, cloudLocked]);

  useEffect(() => {
    if (visible) load();
  }, [visible, load]);

  // Kea Cloud: reload when a sync brings changes, and keep each file's sync state current.
  const cloudTick = `${cloud?.last}:${cloud?.pending}:${cloud?.files}`;
  useEffect(() => {
    if (visible && isCloud && !cloudLocked) load();
  }, [cloudTick]);
  useEffect(() => {
    if (!isCloud || cloudLocked || !badges || !items.length) return setSyncStates({});
    api.keaCloud.states(items.filter((i) => !i.dir).map((i) => i.path)).then((r) => r.ok && setSyncStates(r.value));
  }, [items, isCloud, cloudLocked, badges, cloudTick]);

  const renameCloud = async (it: Item) => {
    const name = await prompt('Rename', 'New name', it.name);
    if (name === null || !name.trim() || name.trim() === it.name) return;
    const r = await api.keaCloud.rename(it.path, name.trim());
    if (!r.ok) return toast(r.error, 'error');
    load();
  };
  const deleteCloud = async (it: Item) => {
    const ok = await ask(`Delete ${it.name}?`, 'It’s removed from Kea Cloud on all your devices. This PC keeps a copy in the Recycle Bin.', [
      { id: 'cancel', label: 'Cancel' },
      { id: 'del', label: 'Delete', danger: true, primary: true },
    ]);
    if (ok !== 'del') return;
    const r = await api.keaCloud.remove(it.path);
    if (!r.ok) return toast(r.error, 'error');
    setItems((l) => l.filter((x) => x.path !== it.path));
  };
  const addToCloud = async () => {
    const picked = await api.openDialog({ title: 'Add files to Kea Cloud', multi: true });
    if (!picked.length) return;
    let n = 0;
    for (const f of picked) {
      const target = await api.keaCloud.newPath(f.name);
      if (!target.ok) {
        toast(target.error, 'error');
        continue;
      }
      // (Video and audio come back from the dialog without their bytes: read them first.)
      const data = f.data?.length ? f.data : (await api.readFile(f.path)).data;
      await api.writeFile(target.value, data);
      n++;
    }
    if (n) toast(`Added ${n} file${n === 1 ? '' : 's'} to Kea Cloud`, 'success');
    load();
  };

  // Search: filter Recent in place; search inside folders (and their subfolders) on disk.
  useEffect(() => {
    if (!dir || !query.trim()) return setSearchHits(null);
    const t = setTimeout(async () => {
      const hits = await api.searchDir(dir, query, { allTypes, hidden }).catch(() => []);
      setSearchHits(hits);
    }, 250);
    return () => clearTimeout(t);
  }, [dir, query, allTypes, hidden]);

  const pickSource = (id: string) => {
    setSourceId(id);
    setSubPath(null);
    setQuery('');
    saveSettings({ source: id });
  };

  const addFolder = async () => {
    const dirs = await api.openFolderDialog();
    if (!dirs) return;
    const folders = Array.from(new Set([...(settings.folders || []), dirs]));
    saveSettings({ folders });
    pickSource('folder:' + dirs);
  };
  const removeFolder = (p: string) => {
    saveSettings({ folders: (settings.folders || []).filter((f) => f !== p) });
    if (sourceId === 'folder:' + p) pickSource('recent');
  };

  const open = (it: Item) => {
    if (it.dir) {
      setSubPath(it.path);
      setQuery('');
      return;
    }
    openPaths([it.path]);
  };

  const editDescription = async (it: Item) => {
    const current = meta[it.path.toLowerCase()]?.description || '';
    const v = await prompt('Description', `A short note about ${it.name}, shown under its name on Home.`, current, 'e.g. Final draft for the history essay');
    if (v === null) return;
    setMeta(await api.setMeta(it.path, { description: v.trim().slice(0, 200) }));
  };

  // ---------- Visible list ----------
  const base = searchHits ?? items;
  const q = query.trim().toLowerCase();
  const folders = searchHits ? [] : base.filter((i) => i.dir && (!q || i.name.toLowerCase().includes(q)));
  const files = base.filter((i) => !i.dir && (searchHits || !q || i.name.toLowerCase().includes(q) || (!dir && i.path.toLowerCase().includes(q)) || (meta[i.path.toLowerCase()]?.description || '').toLowerCase().includes(q)));
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: files.length };
    for (const f of files) c[kindOf(f.name)] = (c[kindOf(f.name)] || 0) + 1;
    return c;
  }, [files]);
  const shown = useMemo(() => {
    const list = filter === 'all' ? files.slice() : files.filter((f) => kindOf(f.name) === filter);
    const by = sort === 'recent' && !dir ? 'recent' : sort === 'name' ? 'name' : 'modified';
    if (by === 'name') list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    else if (by === 'modified') list.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    return list;
  }, [files, filter, sort, dir]);
  const sortedFolders = useMemo(() => folders.slice().sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })), [folders]);

  const crumbs = useMemo(() => {
    if (!dir || !source.path) return [];
    const out = [{ label: source.label, path: source.path }];
    if (subPath && under(subPath, source.path)) {
      const rest = subPath.slice(source.path.replace(/[\\/]+$/, '').length).split(/[\\/]/).filter(Boolean);
      let acc = source.path.replace(/[\\/]+$/, '');
      for (const part of rest) {
        acc += sep(acc) + part;
        out.push({ label: part, path: acc });
      }
    }
    return out;
  }, [dir, source, subPath]);

  const cloudFile = (it: Item) => cloudUsable(cloud) && inKeaCloud(it.path, cloud);

  const fileMenu = (it: Item) => (close: () => void) => (
    <>
      <button className="menu-item" onClick={() => (open(it), close())}>
        <FolderOpen size={16} /> Open in Kea
      </button>
      {GOOGLE_EXT[extOf(it.name)] && (
        <button className="menu-item" onClick={() => (api.openPath(it.path), close())}>
          <ExternalLink size={16} /> Open in browser
        </button>
      )}
      <button className="menu-item" onClick={() => (close(), editDescription(it))}>
        <Pencil size={16} /> {meta[it.path.toLowerCase()]?.description ? 'Edit description' : 'Add description'}
      </button>
      <button className="menu-item" onClick={() => (api.showInFolder(it.path), close())}>
        <FolderSearch size={16} /> Show in folder
      </button>
      <button className="menu-item" onClick={() => (navigator.clipboard.writeText(it.path), toast('Path copied', 'success'), close())}>
        <Copy size={16} /> Copy path
      </button>
      {cloudFile(it) && (
        <>
          <button className="menu-item" onClick={() => (close(), renameCloud(it))}>
            <Pencil size={16} /> Rename
          </button>
          <button className="menu-item danger" onClick={() => (close(), deleteCloud(it))}>
            <Trash2 size={16} /> Delete
          </button>
        </>
      )}
      {!dir && (
        <button
          className="menu-item"
          onClick={async () => {
            await api.removeRecent(it.path);
            setItems((l) => l.filter((x) => x.path !== it.path));
            close();
          }}
        >
          <X size={16} /> Remove from Recent
        </button>
      )}
    </>
  );

  const more = (it: Item) => (
    <span className="more" onClick={(e) => e.stopPropagation()}>
      <MenuButton
        align="right"
        button={() => (
          <button className="icon-btn sm" title="More">
            <MoreVertical size={16} />
          </button>
        )}
      >
        {fileMenu(it)}
      </MenuButton>
    </span>
  );

  const when = (it: Item) => (!dir && it.openedAt ? `Opened ${timeAgo(it.openedAt)}` : it.mtime ? `Edited ${timeAgo(it.mtime)}` : '');
  const where = (it: Item) => (!dir || searchHits ? folderLabel(it.path, cloud) : '');

  const emptyText = error
    ? error
    : q
      ? 'No files match your search.'
      : filter !== 'all' && files.length
        ? `No ${FILTERS.find((f) => f.id === filter)!.label.toLowerCase()} here.`
        : !dir || (isCloud && !subPath)
          ? null
          : 'No documents in this folder.';

  const firstName = String(userName || '').trim().split(/\s+/)[0];
  const today = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

  return (
    <div className="home">
      <div className="home-inner">
        {showGreeting && (
          <header className="home-head">
            <h1 className="home-title">
              {greeting()}
              {firstName ? `, ${firstName}` : ''}
            </h1>
            <p className="home-sub">{today}</p>
          </header>
        )}

        <Dashboard showSchool={showScholar} />

        {showDocs && showStart && (
          <section className="home-create">
            <div className="section-head">
              <h2>Create</h2>
            </div>
            <CreateBar tools={showTools} onTemplates={() => setShowTemplates(true)} />
          </section>
        )}

        {showDocs && (
        <section className="home-docs">
          <div className="section-head">
            <h2>Files</h2>
          </div>
          <div className="files-area">
          <nav className="sources">
            <div className="src-group">
              {sources
                .filter((s) => !s.cloud)
                .map((s) => (
                  <button key={s.id} className={`src ${s.id === source.id ? 'on' : ''}`} onClick={() => pickSource(s.id)} title={s.path}>
                    {s.icon}
                    <span>{s.label}</span>
                    {s.removable && (
                      <span
                        className="src-x"
                        title="Remove from Home"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeFolder(s.path!);
                        }}
                      >
                        <X size={13} />
                      </span>
                    )}
                  </button>
                ))}
              <button className="src add" onClick={addFolder}>
                <FolderPlus size={17} />
                <span>Add a folder</span>
              </button>
            </div>
            <div className="src-head">Cloud</div>
            <div className="src-group">
              {sources
                .filter((s) => s.cloud)
                .map((s) => (
                  <button key={s.id} className={`src ${s.id === source.id ? 'on' : ''}`} onClick={() => pickSource(s.id)} title={s.path}>
                    {s.icon}
                    <span>{s.label}</span>
                  </button>
                ))}
              <button className="src add" onClick={() => setShowDrives(true)}>
                <Plus size={17} />
                <span>Connect a drive</span>
              </button>
            </div>
          </nav>

          <div className="files-main">
            {isCloud && <KeaCloudHeader />}
            {!cloudLocked && (
            <>
            <div className="files-toolbar">
              <div className="crumbs">
                {crumbs.length ? (
                  crumbs.map((c, i) => (
                    <span key={c.path} className="crumb-wrap">
                      {i > 0 && <ChevronRight size={15} className="muted" />}
                      <button className={`crumb ${i === crumbs.length - 1 ? 'here' : ''}`} onClick={() => (i === 0 ? setSubPath(null) : setSubPath(c.path))}>
                        {c.label}
                      </button>
                    </span>
                  ))
                ) : (
                  <span className="crumb here">{source.label}</span>
                )}
                {loading && <Loader2 size={15} className="spin muted" />}
              </div>
              <div className="search-box">
                <Search size={16} />
                <input placeholder={dir ? `Search ${crumbs[crumbs.length - 1]?.label || 'folder'}` : 'Search recent files'} value={query} onChange={(e) => setQuery(e.target.value)} />
                {query && (
                  <button className="icon-btn sm" onClick={() => setQuery('')}>
                    <X size={14} />
                  </button>
                )}
              </div>
              <MenuButton
                align="right"
                button={() => (
                  <button className="icon-btn" title="Sort and view">
                    <ArrowUpDown size={17} />
                  </button>
                )}
              >
                {(close) => (
                  <>
                    {(
                      [
                        ['recent', 'Last opened'],
                        ['modified', 'Last edited'],
                        ['name', 'Name']
                      ] as const
                    ).map(([id, label]) => (
                      <button key={id} className="menu-item" onClick={() => (saveSettings({ sort: id }), close())}>
                        <span style={{ width: 16 }}>{sort === id && <Check size={15} />}</span> {label}
                      </button>
                    ))}
                    <div className="menu-sep" />
                    {/* How the file previews look (only the previews: the app's theme is in Settings). */}
                    <button className="menu-item" onClick={() => (saveSettings({ tone: tone === 'dark' ? 'light' : 'dark' }), close())}>
                      {tone === 'dark' ? <Sun size={15} /> : <Moon size={15} />} {tone === 'dark' ? 'Light previews' : 'Dark previews'}
                    </button>
                  </>
                )}
              </MenuButton>
              {isCloud && (
                <button className="icon-btn" title="Add files to Kea Cloud" onClick={addToCloud}>
                  <Upload size={17} />
                </button>
              )}
              <div className="seg-toggle">
                <button className={view === 'grid' ? 'on' : ''} title="Grid" onClick={() => saveSettings({ view: 'grid' })}>
                  <LayoutGrid size={16} />
                </button>
                <button className={view === 'list' ? 'on' : ''} title="List" onClick={() => saveSettings({ view: 'list' })}>
                  <List size={16} />
                </button>
              </div>
            </div>

            <div className="filter-tabs">
              {FILTERS.map((f) => (
                <button key={f.id} className={`ftab ${filter === f.id ? 'on' : ''}`} onClick={() => setFilter(f.id)}>
                  {f.label}
                  {counts[f.id] ? <span className="ftab-n">{counts[f.id]}</span> : null}
                </button>
              ))}
            </div>

            {sortedFolders.length > 0 && (
              <div className="folder-grid">
                {sortedFolders.map((f) => (
                  <button key={f.path} className="folder-tile" onClick={() => open(f)} title={f.path}>
                    <Folder size={18} />
                    <span>{f.name}</span>
                  </button>
                ))}
              </div>
            )}

            {shown.length === 0 ? (
              !loading &&
              !(sortedFolders.length && !error && !q && filter === 'all') && (
                <div className="recent-empty">
                  {emptyText ?? (
                    <>
                      <FolderOpen size={40} strokeWidth={1.4} />
                      <div>{isCloud ? 'Nothing in Kea Cloud yet' : 'No recent files yet'}</div>
                      <div className="muted">
                        {isCloud ? (
                          <>Save a document and choose Kea Cloud, or add files with the upload button above.</>
                        ) : (
                          <>
                            Press <span className="kbd-chip">Ctrl</span> + <span className="kbd-chip">O</span>, drop files on this window, or pick a folder on the left
                          </>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )
            ) : view === 'grid' ? (
              <div className={`file-grid tone-${tone} size-${cardSize} ${showDesc ? '' : 'no-desc'}`}>
                {shown.map((it) => {
                  const desc = meta[it.path.toLowerCase()]?.description;
                  return (
                    <div key={it.path} className="fcard" onClick={() => open(it)} title={friendlyPath(it.path, cloud)}>
                      <div className="fcard-thumb">
                        <Preview path={it.path} name={it.name} mtime={it.mtime} online={it.online} iconOnly={!showPreviews} />
                      </div>
                      <div className="fcard-body">
                        <div className="fcard-title">
                          <FileIcon kind={kindOf(it.name)} size={16} />
                          <span className="fcard-name">{it.name}</span>
                          <SyncMark state={syncStates[it.path]} />
                          {more(it)}
                        </div>
                        {!showDesc ? null : desc ? (
                          <div className="fcard-desc">{desc}</div>
                        ) : (
                          <button
                            className="fcard-desc add"
                            onClick={(e) => {
                              e.stopPropagation();
                              editDescription(it);
                            }}
                          >
                            Add a description
                          </button>
                        )}
                        <div className="fcard-meta">
                          {when(it)}
                          {where(it) && <> · {where(it)}</>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="file-list">
                <div className="flist-head">
                  <span>Name</span>
                  <span>{dir && !searchHits ? '' : 'Location'}</span>
                  <span>{!dir && sort === 'recent' ? 'Opened' : 'Edited'}</span>
                  <span>Size</span>
                  <span />
                </div>
                {shown.map((it) => {
                  const desc = meta[it.path.toLowerCase()]?.description;
                  return (
                    <div key={it.path} className="flist-row" onClick={() => open(it)} title={friendlyPath(it.path, cloud)}>
                      <span className="flist-name">
                        <FileIcon kind={kindOf(it.name)} size={20} />
                        <span>
                          <span className="nm">
                            {it.name} <SyncMark state={syncStates[it.path]} />
                          </span>
                          {desc && <span className="ds">{desc}</span>}
                        </span>
                      </span>
                      <span className="muted">{where(it)}</span>
                      <span className="muted">{timeAgo((!dir && sort === 'recent' ? it.openedAt : it.mtime) || it.mtime || 0)}</span>
                      <span className="muted">{it.online ? 'Online' : it.size != null ? formatBytes(it.size) : ''}</span>
                      {more(it)}
                    </div>
                  );
                })}
              </div>
            )}
            </>
            )}
          </div>
          </div>
        </section>
        )}
        {areas.length === 0 && <p className="home-sub">Every area of Kea is turned off. Turn one on in Settings → General → Home.</p>}
        <SupportLink />
      </div>
      {showTemplates && <TemplateGallery onClose={() => setShowTemplates(false)} />}
      {showDrives && <ConnectDrives drives={drives} onClose={() => (setShowDrives(false), refreshDrives())} onChange={setDrives} />}
    </div>
  );
}
