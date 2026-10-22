import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FileText,
  Sheet,
  FileCode2,
  FolderOpen,
  Combine,
  Images,
  Search,
  X,
  FolderSearch,
  FileType2,
  Presentation,
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
  GraduationCap,
} from 'lucide-react';
import { api, DirEntry, DriveInfo, FileMeta, HomeSettings, KnownFolder } from '../lib/api';
import { newFile, openPaths, openWithDialog } from '../lib/open';
import { FileIcon } from './FileIcon';
import { timeAgo, formatBytes } from '../lib/util';
import { useTabs, toast, prompt } from '../store';
import { mergePdfs, imagesToPdf } from '../lib/pdfTools';
import { MenuButton } from './Popover';
import { kindFor, extOf } from '../lib/fileTypes';
import { openScholar } from './scholar/scholarStore';
import { Preview } from './home/Preview';
import { ConnectDrives } from './home/ConnectDrives';
import { DriveLogo } from './home/DriveLogo';
import { TemplateGallery } from './home/Templates';
import { LayoutTemplate, Clapperboard, ImagePlus } from 'lucide-react';
import { useSetting } from '../lib/settings';

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Working late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
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
const parentName = (p: string) => p.split(/[\\/]/).slice(-2, -1)[0] || p;
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
  const loadSeq = useRef(0);
  const showStart = useSetting<boolean>('home.showStart');
  const showScholar = useSetting<boolean>('scholar.enabled');
  const showTools = useSetting<boolean>('home.showTools');
  const showGreeting = useSetting<boolean>('home.greeting');
  const showPreviews = useSetting<boolean>('home.previews');
  const cardSize = useSetting<string>('home.cardSize');
  const showDesc = useSetting<boolean>('home.descriptions');
  const previewOnline = useSetting<boolean>('home.previewOnline');
  const allTypes = useSetting<boolean>('home.showAllTypes');
  const hidden = useSetting<boolean>('home.showHidden');

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
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const sources = useMemo<Source[]>(() => {
    const icon = (id: string) => (id === 'desktop' ? <Monitor size={17} /> : id === 'downloads' ? <Download size={17} /> : <FileText size={17} />);
    const list: Source[] = [{ id: 'recent', label: 'Recent', icon: <Clock size={17} /> }];
    for (const k of known) list.push({ id: k.id, label: k.label, path: k.path, icon: icon(k.id) });
    for (const f of settings.folders || []) list.push({ id: 'folder:' + f, label: f.split(/[\\/]/).filter(Boolean).pop() || f, path: f, icon: <Folder size={17} />, removable: true });
    for (const d of drives)
      for (const a of d.accounts)
        list.push({ id: `${d.id}:${a.path}`, label: d.accounts.length > 1 || a.label !== d.label ? `${d.label === a.label ? '' : d.label + ' · '}${a.label}` : d.label, path: a.path, icon: <DriveLogo id={d.id} size={17} />, cloud: d.id });
    return list;
  }, [known, drives, settings.folders]);

  const source = sources.find((s) => s.id === sourceId) || sources[0];
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
      if (!dir) {
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
  }, [dir, drives, previewOnline, allTypes, hidden]);

  useEffect(() => {
    if (visible) load();
  }, [visible, load]);

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

  // ---------- Quick actions ----------
  const merge = async () => {
    const picked = await api.openDialog({ title: 'Choose PDFs to combine', multi: true, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (picked.length < 1) return;
    try {
      const bytes = await mergePdfs(picked.map((f) => f.data));
      useTabs.getState().addTab({ kind: 'pdf', name: 'Combined.pdf', path: null, data: bytes });
      toast(`Combined ${picked.length} PDFs. Reorder pages in the sidebar, then save.`, 'success');
    } catch (e: any) {
      toast(`Couldn't combine: ${e.message}`, 'error');
    }
  };
  const imgToPdf = async () => {
    const picked = await api.openDialog({ title: 'Choose images', multi: true, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] });
    if (!picked.length) return;
    try {
      useTabs.getState().addTab({ kind: 'pdf', name: 'Images.pdf', path: null, data: await imagesToPdf(picked) });
    } catch (e: any) {
      toast(`Couldn't convert: ${e.message}`, 'error');
    }
  };
  const openPdf = async () => {
    const picked = await api.openDialog({ title: 'Open PDF', multi: true, filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (picked.length) openPaths(picked.map((f) => f.path));
  };

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
  const where = (it: Item) => (!dir || searchHits ? parentName(it.path) : '');

  const emptyText = error
    ? error
    : q
      ? 'No files match your search.'
      : filter !== 'all' && files.length
        ? `No ${FILTERS.find((f) => f.id === filter)!.label.toLowerCase()} here.`
        : !dir
          ? null
          : 'No documents in this folder.';

  return (
    <div className="home">
      <div className="home-inner">
        {showGreeting && (
          <>
            <h1 className="home-title">{greeting()}</h1>
            <p className="home-sub">Your classes, readings and files in one place. Everything stays on this computer and your own drives.</p>
          </>
        )}

        {showScholar !== false && (
          <section className="scholar-start">
            <div className="section-head">
              <h2>Scholar</h2>
              <span className="muted">Your classes, their textbooks and your calendar, kept up to date for you.</span>
            </div>
            <div className="scholar-row">
              <button className="scholar-card wide" onClick={() => openScholar({ name: 'week' })}>
                <GraduationCap size={26} />
                <span className="scholar-name">Open this week</span>
                <span className="scholar-desc">What's due, your readings and textbooks, the calendar and the Library, all in Scholar</span>
              </button>
            </div>
          </section>
        )}

        {(showStart || showTools) && (
        <section className={`home-start ${showScholar !== false ? 'compact' : ''}`}>
          {showScholar !== false && <div className="section-head"><h2>Office</h2></div>}
          {showStart && (
          <div className="start-row">
            <button className="start-card" onClick={() => newFile('doc')}>
              <div className="start-thumb doc">
                <FileText size={28} />
              </div>
              <span>Document</span>
            </button>
            <button className="start-card" onClick={() => newFile('sheet')}>
              <div className="start-thumb sheet">
                <Sheet size={28} />
              </div>
              <span>Spreadsheet</span>
            </button>
            <button className="start-card" onClick={() => newFile('slides')}>
              <div className="start-thumb slides">
                <Presentation size={28} />
              </div>
              <span>Presentation</span>
            </button>
            <button className="start-card" onClick={() => newFile('code')}>
              <div className="start-thumb code">
                <FileCode2 size={28} />
              </div>
              <span>Text file</span>
            </button>
            <button className="start-card" onClick={() => newFile('image')}>
              <div className="start-thumb image">
                <ImagePlus size={28} />
              </div>
              <span>Image</span>
            </button>
            <button className="start-card" onClick={() => newFile('video')}>
              <div className="start-thumb video">
                <Clapperboard size={28} />
              </div>
              <span>Video</span>
            </button>
            <button className="start-card" onClick={openPdf}>
              <div className="start-thumb pdf">
                <FileType2 size={28} />
              </div>
              <span>Edit a PDF</span>
            </button>
            <button className="start-card" onClick={() => setShowTemplates(true)}>
              <div className="start-thumb tpl">
                <LayoutTemplate size={28} />
              </div>
              <span>Templates</span>
            </button>
          </div>
          )}
          {showTools && (
          <div className="tool-row">
            <button className="tool-chip" onClick={openWithDialog}>
              <FolderOpen size={16} /> Open a file
            </button>
            <button className="tool-chip" onClick={merge}>
              <Combine size={16} /> Combine PDFs
            </button>
            <button className="tool-chip" onClick={imgToPdf}>
              <Images size={16} /> Images to PDF
            </button>
          </div>
          )}
        </section>
        )}

        <section className="files-area">
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
            <div className="src-head">Cloud drives</div>
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
                  <button className="icon-btn" title="Sort">
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
                  </>
                )}
              </MenuButton>
              <button className="icon-btn" title={tone === 'dark' ? 'Previews: dark (click for light)' : 'Previews: light (click for dark)'} onClick={() => saveSettings({ tone: tone === 'dark' ? 'light' : 'dark' })}>
                {tone === 'dark' ? <Moon size={17} /> : <Sun size={17} />}
              </button>
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
                      <div>No recent files yet</div>
                      <div className="muted">
                        Press <span className="kbd-chip">Ctrl</span> + <span className="kbd-chip">O</span>, drop files on this window, or pick a folder on the left
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
                    <div key={it.path} className="fcard" onClick={() => open(it)} title={it.path}>
                      <div className="fcard-thumb">
                        <Preview path={it.path} name={it.name} mtime={it.mtime} online={it.online} iconOnly={!showPreviews} />
                      </div>
                      <div className="fcard-body">
                        <div className="fcard-title">
                          <FileIcon kind={kindOf(it.name)} size={16} />
                          <span className="fcard-name">{it.name}</span>
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
                    <div key={it.path} className="flist-row" onClick={() => open(it)} title={it.path}>
                      <span className="flist-name">
                        <FileIcon kind={kindOf(it.name)} size={20} />
                        <span>
                          <span className="nm">{it.name}</span>
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
          </div>
        </section>
      </div>
      {showTemplates && <TemplateGallery onClose={() => setShowTemplates(false)} />}
      {showDrives && <ConnectDrives drives={drives} onClose={() => (setShowDrives(false), refreshDrives())} onChange={setDrives} />}
    </div>
  );
}
