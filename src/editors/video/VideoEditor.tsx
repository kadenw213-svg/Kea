import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Undo2,
  Redo2,
  MousePointer2,
  Scissors,
  FoldHorizontal,
  Columns2,
  MoveHorizontal,
  Magnet,
  Flag,
  Type,
  Shapes,
  Save,
  MoreVertical,
  Download,
  Camera,
  CircleHelp,
  Upload,
  RectangleHorizontal,
  Square,
  Circle,
  Settings2,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Link2,
  Unlink2,
  Trash2
} from 'lucide-react';
import type { Tab } from '../../store';
import { editorRegistry, setDirty, toast, proxyAi, AiHooks } from '../../store';
import { saveTabFile, exportFile, isSilentSave } from '../../lib/save';
import { extOf, baseName } from '../../lib/fileTypes';
import { api } from '../../lib/api';
import { uid, clamp, textToBytes, bytesToText, blobToBytes } from '../../lib/util';
import { MenuButton } from '../../components/Popover';
import type { Project, MediaItem, Aspect } from './model';
import { newProject, parseProject, serializeProject, projectDuration, ASPECTS, FPS_CHOICES, aspectOf, timecode } from './model';
import { makeStore, StoreContext, useVE, Store, Tool } from './state';
import { Player } from './player';
import { probe, warmMedia, mediaKey, useMediaCache } from './media';
import { seedBlob, fileExists, VIDEO_EXTS, AUDIO_EXTS, IMAGE_EXTS } from './host';
import { clipsForMedia, overwrite } from './ops';
import { Timeline, HEAD_W } from './Timeline';
import { Monitor } from './Monitor';
import { Library, LibraryTab } from './Library';
import type { SourceControls } from './SourceViewer';
import { Inspector } from './Inspector';
import { ExportDialog } from './ExportDialog';
import { renderStill } from './exporter';
import { describeProject, projectSections, snapshot, videoTools } from './assistant';
import * as act from './actions';
import './video.css';
import { LookupButton } from '../../components/lookup/LookupButton';
import { AssistantButton } from '../../components/assistant/AssistantPanel';

/* Video editor: media bin, source/program monitors, inspector and a multi-track timeline. */

export const MEDIA_EXTS = [...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS];

/** Build the starting project from the opened tab: a .keavideo file, or a media file on a new timeline. */
async function openProject(tab: Tab): Promise<Project> {
  const ext = extOf(tab.name);
  if (ext === 'keavideo') {
    if (!tab.data?.length) return newProject();
    const p = parseProject(bytesToText(tab.data || new Uint8Array()));
    const found = await Promise.all(p.media.map((m) => fileExists(m.path)));
    const missing: Record<string, boolean> = {};
    p.media.forEach((m, i) => {
      if (!found[i]) missing[mediaKey(m)] = true;
      else warmMedia(m);
    });
    useMediaCache.getState().set({ missing });
    return p;
  }
  const p = newProject();
  // (A video opened from disk arrives as just its path, streamed from there; one without a path brings its bytes.)
  if ((!tab.data?.length && !tab.path) || !MEDIA_EXTS.includes(ext)) return p;
  const id = uid();
  const key = tab.path || `mem:${id}`;
  if (tab.data?.length) seedBlob(key, tab.data, tab.name);
  const m = { ...(await probe(tab.path || '', tab.name, key)), id };
  matchSettings(p, m);
  p.media.push(m);
  overwrite(p, clipsForMedia(p, m, 0));
  warmMedia(m);
  return p;
}

/** Make an empty project's frame size and rate match a video. */
function matchSettings(p: Project, m: MediaItem) {
  if (m.kind !== 'video' || !m.width) return;
  p.settings.width = Math.round(m.width / 2) * 2;
  p.settings.height = Math.round(m.height / 2) * 2;
  p.settings.aspect = aspectOf(p.settings.width, p.settings.height);
  const near = FPS_CHOICES.reduce((a, b) => (Math.abs(b - m.fps) < Math.abs(a - m.fps) ? b : a), 30);
  p.settings.fps = Math.abs(near - m.fps) < 0.05 ? near : Math.round(m.fps);
}

export default function VideoEditor({ tab, active }: { tab: Tab; active: boolean }) {
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    openProject(tab).then(setProject, (err) => {
      console.error(err);
      setError(err?.message || String(err));
    });
  }, []);
  if (error)
    return (
      <div className="center-fill">
        <div style={{ textAlign: 'center', maxWidth: 420 }}>
          <h3 style={{ color: 'var(--text)', fontWeight: 500 }}>Couldn't open this video</h3>
          <p>{error}</p>
        </div>
      </div>
    );
  if (!project)
    return (
      <div className="center-fill">
        <div className="spinner" />
      </div>
    );
  return <VideoInner tab={tab} active={active} initial={project} />;
}

const LAYOUT = 'kea.video.layout';
interface Layout {
  left: number;
  right: number;
  bottom: number;
}

function VideoInner({ tab, active, initial }: { tab: Tab; active: boolean; initial: Project }) {
  const store = useMemo(() => makeStore(initial), []);
  const player = useMemo(() => new Player(store), [store]);
  useEffect(() => () => player.dispose(), [player]);
  return (
    <StoreContext.Provider value={store}>
      <Shell tab={tab} active={active} store={store} player={player} />
    </StoreContext.Provider>
  );
}

function Shell({ tab, active, store, player }: { tab: Tab; active: boolean; store: Store; player: Player }) {
  const project = useVE((s) => s.project);
  const tool = useVE((s) => s.tool);
  const snapping = useVE((s) => s.snapping);
  const canUndo = useVE((s) => s.past.length > 0);
  const canRedo = useVE((s) => s.future.length > 0);
  const rev = useVE((s) => s.rev);
  const savedRev = useVE((s) => s.savedRev);
  const sel = useVE((s) => s.sel);
  const [libTab, setLibTab] = useState<LibraryTab>('media');
  const [exporting, setExporting] = useState(false);
  const [layout, setLayout] = useState<Layout>(() => {
    try {
      return { left: 320, right: 300, bottom: 300, ...JSON.parse(localStorage.getItem(LAYOUT) || '{}') };
    } catch {
      return { left: 320, right: 300, bottom: 300 };
    }
  });
  const sourceControls = useRef<SourceControls | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const dirty = rev !== savedRev;

  useEffect(() => setDirty(tab.id, dirty), [dirty]);
  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT, JSON.stringify(layout));
    } catch {
      /* not important */
    }
  }, [layout]);
  useEffect(() => {
    if (!active && store.getState().playing) player.pause();
  }, [active]);

  /* ---------- Importing ---------- */

  const importEntries = async (entries: { path: string; name: string; data?: Blob | Uint8Array }[]): Promise<MediaItem[]> => {
    const out: MediaItem[] = [];
    const fresh: MediaItem[] = [];
    for (const e of entries) {
      const ext = extOf(e.name);
      if (!MEDIA_EXTS.includes(ext)) {
        toast(`${e.name} isn't a video, audio or picture file`, 'error');
        continue;
      }
      const have = e.path && store.getState().project.media.find((m) => m.path === e.path);
      if (have) {
        out.push(have);
        continue;
      }
      const id = uid();
      const key = e.path || `mem:${id}`;
      if (e.data) seedBlob(key, e.data, e.name);
      try {
        const m = { ...(await probe(e.path, e.name, key)), id };
        out.push(m);
        fresh.push(m);
      } catch (err: any) {
        toast(err?.message || `Couldn't import ${e.name}`, 'error');
      }
    }
    if (fresh.length) {
      store.getState().commit(fresh.length > 1 ? `Import ${fresh.length} files` : 'Import media', (p) => {
        // The first video into an empty project sets its size and frame rate.
        const firstVideo = fresh.find((m) => m.kind === 'video');
        if (!p.media.length && !p.clips.length && firstVideo) matchSettings(p, firstVideo);
        p.media.push(...fresh);
      });
      fresh.forEach(warmMedia);
      if (fresh.some((m) => !m.path)) toast('Some media has no file on disk, so it won’t be saved with the project', 'info');
    }
    return out;
  };

  const importDialog = async () => {
    const files = await api.openDialog({ title: 'Import media', multi: true, filters: [{ name: 'Video, audio and pictures', extensions: MEDIA_EXTS }] });
    if (files.length) await importEntries(files.map((f) => ({ path: f.path, name: f.name, data: f.data })));
  };
  const dropFiles = (files: File[]) => importEntries(files.map((f) => ({ path: safePath(f), name: f.name, data: f })));
  const dropOnTimeline = async (files: File[], at: number, trackId: string | null) => {
    const items = await dropFiles(files);
    let t = at;
    const track = store.getState().project.tracks.find((x) => x.id === trackId);
    for (const m of items) {
      const made = act.placeMedia(store, m, t, { vTrack: track?.kind === 'video' ? track.id : undefined, aTrack: track?.kind === 'audio' ? track.id : undefined });
      t = Math.max(t, ...made.map((c) => c.start + (c.out - c.in) / c.speed));
    }
  };
  const importPaths = async (paths: string[]) => {
    const entries: { path: string; name: string }[] = [];
    for (const p of paths) {
      if (!(await fileExists(p))) throw new Error(`There's no file at ${p}`);
      entries.push({ path: p, name: p.split(/[\\/]/).pop() || p });
    }
    const items = await importEntries(entries);
    if (!items.length) throw new Error("Those files couldn't be imported");
    return items;
  };

  /* ---------- Saving, exporting, the assistant ---------- */

  const build = () => {
    const s = store.getState();
    return Promise.resolve(textToBytes(serializeProject({ ...s.project, view: { playhead: s.playhead, zoom: s.zoom } })));
  };
  const save = async (saveAs: boolean) => {
    const rev0 = store.getState().rev;
    const ok = await saveTabFile(tab.id, [{ name: 'Kea video project', ext: 'keavideo', build }], saveAs || extOf(tab.path || tab.name) !== 'keavideo');
    if (ok) store.setState({ savedRev: rev0 });
    if (ok && !isSilentSave() && store.getState().project.media.some((m) => !m.path)) toast('Media that only lived in memory isn’t in the saved project', 'info');
    return ok;
  };
  const exportPng = async () => {
    const s = store.getState();
    const name = `${baseName(tab.name)} ${timecode(s.playhead, s.project.settings.fps).replace(/:/g, '.')}.png`;
    await exportFile(name, {
      name: 'PNG image',
      ext: 'png',
      build: async () => {
        const c = await renderStill(s.project, s.playhead, s.project.settings.width, s.project.settings.height);
        return blobToBytes(await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png')));
      }
    });
  };

  const tools = useMemo(() => videoTools({ store, player, importPaths }), [store, player]);
  const aiRef = useRef<AiHooks>(null as any);
  aiRef.current = {
    noun: 'video',
    async getDocument() {
      return { full: describeProject(store), sections: projectSections(store) };
    },
    getImage: () => snapshot(store),
    tools
  };
  const handlers = useRef({ save });
  handlers.current = { save };
  useEffect(() => {
    editorRegistry.set(tab.id, { save: (a) => handlers.current.save(a), debugBuild: build, ai: proxyAi(aiRef) });
  }, [tab.id]);

  /* ---------- Keyboard ---------- */

  const zoomBy = (k: number) => store.getState().set({ zoom: clamp(store.getState().zoom * k, 2, 2000) });
  const zoomFit = () => {
    const el = rootRef.current?.querySelector('.ve-tl-scroll') as HTMLElement | null;
    const w = (el?.clientWidth || 800) - HEAD_W - 40;
    store.getState().set({ zoom: clamp(w / Math.max(5, projectDuration(store.getState().project)), 2, 2000) });
    if (el) el.scrollLeft = 0;
  };
  const undo = () => {
    const l = store.getState().undo();
    if (l) toast(`Undid ${l.toLowerCase()}`);
  };
  const redo = () => {
    const l = store.getState().redo();
    if (l) toast(`Redid ${l.toLowerCase()}`);
  };
  const setTool = (t: Tool) => store.getState().set({ tool: t });

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target instanceof Element ? e.target : null;
      if (el?.closest('input, textarea, select, [contenteditable="true"]') || document.querySelector('.scrim')) return;
      const s = store.getState();
      const k = e.key.toLowerCase();
      const ctrl = e.ctrlKey || e.metaKey;
      const src = s.focus === 'source' ? sourceControls.current : null;
      const handled = () => e.preventDefault();
      if (ctrl) {
        if (k === 'z' && !e.shiftKey) return handled(), undo();
        if ((k === 'z' && e.shiftKey) || k === 'y') return handled(), redo();
        if (k === 'k' || k === 'b') return handled(), act.splitAtPlayhead(store);
        if (k === 'c') return handled(), act.copySelection(store);
        if (k === 'x') return handled(), act.copySelection(store, true);
        if (k === 'v') return handled(), act.pasteClipboard(store);
        if (k === 'd') return handled(), act.duplicateSelection(store);
        if (k === 'a') return handled(), act.selectAll(store);
        if (k === 'l') return handled(), act.linkSelection(store, !s.project.clips.some((c) => s.sel.includes(c.id) && c.linkId));
        if (k === 'i') return handled(), importDialog();
        if (k === 'e' && e.shiftKey) return handled(), exportPng();
        if (k === 'e') return handled(), setExporting(true);
        if (k === 't') return handled(), act.addText(store);
        return;
      }
      if (e.altKey) {
        if (k === 'x') return handled(), act.setInOut(store, 'clear');
        if (e.key === 'ArrowLeft') return handled(), act.nudge(store, e.shiftKey ? -10 : -1);
        if (e.key === 'ArrowRight') return handled(), act.nudge(store, e.shiftKey ? 10 : 1);
        return;
      }
      switch (e.key) {
        case ' ':
          handled();
          return src ? src.toggle() : player.toggle(e.shiftKey);
        case 'ArrowLeft':
          handled();
          return src ? src.step(e.shiftKey ? -10 : -1) : player.step(e.shiftKey ? -10 : -1);
        case 'ArrowRight':
          handled();
          return src ? src.step(e.shiftKey ? 10 : 1) : player.step(e.shiftKey ? 10 : 1);
        case 'ArrowUp':
          handled();
          return act.jumpEdit(store, -1);
        case 'ArrowDown':
          handled();
          return act.jumpEdit(store, 1);
        case 'Home':
          handled();
          return s.seek(0);
        case 'End':
          handled();
          return s.seek(projectDuration(s.project));
        case 'Delete':
        case 'Backspace':
          handled();
          return act.deleteSelection(store, e.shiftKey);
        case 'Escape':
          return s.select([]);
        case ',':
          return src || s.source ? (handled(), sourceControls.current?.send('insert')) : undefined;
        case '.':
          return src || s.source ? (handled(), sourceControls.current?.send('overwrite')) : undefined;
        case '+':
        case '=':
          handled();
          return zoomBy(1.4);
        case '-':
          handled();
          return zoomBy(1 / 1.4);
        case '\\':
          handled();
          return zoomFit();
      }
      if (e.shiftKey) return;
      switch (k) {
        case 'j':
        case 'k':
        case 'l':
          handled();
          return src ? src.shuttle(k) : player.shuttle(k);
        case 'i':
          handled();
          return src ? src.mark('in') : act.setInOut(store, 'in');
        case 'o':
          handled();
          return src ? src.mark('out') : act.setInOut(store, 'out');
        case 'v':
          return setTool('select');
        case 'c':
          return setTool(s.tool === 'razor' ? 'select' : 'razor');
        case 'b':
          return setTool('ripple');
        case 'n':
          return setTool('roll');
        case 'y':
          return setTool('slip');
        case 's':
          return s.set({ snapping: !s.snapping });
        case 'm':
          return act.addMarker(store);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active]);

  /* ---------- Resizable panes ---------- */

  const resize = (which: keyof Layout, e: React.PointerEvent) => {
    e.preventDefault();
    const start = { x: e.clientX, y: e.clientY, v: layout[which] };
    const move = (ev: PointerEvent) => {
      const d = which === 'left' ? ev.clientX - start.x : which === 'right' ? start.x - ev.clientX : start.y - ev.clientY;
      const max = which === 'bottom' ? (rootRef.current?.clientHeight || 800) - 220 : 560;
      setLayout((l) => ({ ...l, [which]: clamp(start.v + d, which === 'bottom' ? 150 : 220, max) }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.cursor = '';
    };
    document.body.style.cursor = which === 'bottom' ? 'row-resize' : 'col-resize';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const s = project.settings;
  const setSettings = (patch: Partial<Project['settings']>, label = 'Project settings') => store.getState().commit(label, (p) => Object.assign(p.settings, patch));
  const toolBtn = (t: Tool, icon: React.ReactNode, title: string) => (
    <button className={`icon-btn ${tool === t ? 'active' : ''}`} title={title} onClick={() => setTool(t)}>
      {icon}
    </button>
  );
  const linkedSel = project.clips.some((c) => sel.includes(c.id) && c.linkId);

  return (
    <div className="video-editor" ref={rootRef}>
      <div className="toolbar">
        <button className="icon-btn" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={undo}>
          <Undo2 size={18} />
        </button>
        <button className="icon-btn" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={redo}>
          <Redo2 size={18} />
        </button>
        <div className="tb-sep" />
        <button className="btn tonal sm" title="Import video, audio or pictures (Ctrl+I)" onClick={importDialog}>
          <Upload size={16} /> Import
        </button>
        <div className="tb-sep" />
        {toolBtn('select', <MousePointer2 size={18} />, 'Select and move (V)')}
        {toolBtn('razor', <Scissors size={18} />, 'Razor: click a clip to cut it (C)')}
        {toolBtn('ripple', <FoldHorizontal size={18} />, 'Ripple trim: trimming an edge closes or opens the gap (B)')}
        {toolBtn('roll', <Columns2 size={18} />, 'Roll: drag a cut to move it between two clips (N)')}
        {toolBtn('slip', <MoveHorizontal size={18} />, 'Slip: change which part of the source a clip shows (Y)')}
        <button className={`icon-btn ${snapping ? 'active' : ''}`} title={`Snapping ${snapping ? 'on' : 'off'} (S)`} onClick={() => store.getState().set({ snapping: !snapping })}>
          <Magnet size={18} />
        </button>
        <div className="tb-sep" />
        <button className="icon-btn" title="Split at playhead (Ctrl+K)" onClick={() => act.splitAtPlayhead(store)}>
          <Scissors size={16} style={{ transform: 'rotate(90deg)' }} />
        </button>
        <button className="icon-btn" title="Add marker (M)" onClick={() => act.addMarker(store)}>
          <Flag size={18} />
        </button>
        <button className="icon-btn" title="Add text (Ctrl+T)" onClick={() => act.addText(store)}>
          <Type size={18} />
        </button>
        <MenuButton
          title="Shapes and colour mattes"
          button={() => (
            <button className="icon-btn">
              <Shapes size={18} />
            </button>
          )}
        >
          {(close) => (
            <>
              <button className="menu-item" onClick={() => (act.addShape(store, { shape: 'matte', fill: '#000000' }), close())}>
                <RectangleHorizontal size={16} /> Colour matte
              </button>
              <button className="menu-item" onClick={() => (act.addShape(store, { shape: 'rect', w: Math.round(s.width * 0.4), h: Math.round(s.height * 0.25) }), close())}>
                <Square size={16} /> Rectangle
              </button>
              <button className="menu-item" onClick={() => (act.addShape(store, { shape: 'ellipse', w: Math.round(s.height * 0.4), h: Math.round(s.height * 0.4) }), close())}>
                <Circle size={16} /> Circle
              </button>
            </>
          )}
        </MenuButton>
        <button className="icon-btn" title={linkedSel ? 'Unlink picture and sound (Ctrl+L)' : 'Link selected clips (Ctrl+L)'} disabled={!sel.length} onClick={() => act.linkSelection(store, !linkedSel)}>
          {linkedSel ? <Unlink2 size={18} /> : <Link2 size={18} />}
        </button>
        <div className="tb-sep" />
        <button className="icon-btn" title="Zoom timeline out (-)" onClick={() => zoomBy(1 / 1.4)}>
          <ZoomOut size={18} />
        </button>
        <button className="icon-btn" title="Zoom timeline in (+)" onClick={() => zoomBy(1.4)}>
          <ZoomIn size={18} />
        </button>
        <button className="icon-btn" title="Fit the timeline (\)" onClick={zoomFit}>
          <Maximize2 size={17} />
        </button>
        <div className="tb-spacer" />
        <MenuButton
          align="right"
          title="Project settings"
          button={() => (
            <button className="btn tonal sm">
              <Settings2 size={15} /> {s.width}×{s.height} · {s.fps} fps
            </button>
          )}
        >
          {() => <SettingsPop project={project} set={setSettings} />}
        </MenuButton>
        <MenuButton
          align="right"
          title="Keyboard shortcuts"
          button={() => (
            <button className="icon-btn">
              <CircleHelp size={18} />
            </button>
          )}
        >
          {() => <Shortcuts />}
        </MenuButton>
        <LookupButton />
        <AssistantButton />
        <button className="btn tonal sm" title="Export (Ctrl+E)" onClick={() => setExporting(true)}>
          <Download size={16} /> Export
        </button>
        <button className="btn primary sm" onClick={() => save(false)} disabled={!dirty && !!tab.path && extOf(tab.path) === 'keavideo'} title="Save the project (Ctrl+S)">
          <Save size={16} /> Save
        </button>
        <MenuButton
          align="right"
          button={() => (
            <button className="icon-btn" title="More">
              <MoreVertical size={18} />
            </button>
          )}
        >
          {(close) => (
            <>
              <button className="menu-item" onClick={() => (save(true), close())}>
                <Save size={16} /> Save project as… <span className="kbd">Ctrl+Shift+S</span>
              </button>
              <button className="menu-item" onClick={() => (exportPng(), close())}>
                <Camera size={16} /> Export this frame as PNG… <span className="kbd">Ctrl+Shift+E</span>
              </button>
              <div className="menu-sep" />
              <button
                className="menu-item"
                onClick={() => {
                  close();
                  const used = new Set(project.clips.map((c) => c.mediaId));
                  const n = project.media.filter((m) => !used.has(m.id)).length;
                  if (!n) return toast('All media is in use');
                  store.getState().commit('Remove unused media', (p) => void (p.media = p.media.filter((m) => used.has(m.id))));
                  toast(`Removed ${n} unused item${n > 1 ? 's' : ''}`);
                }}
              >
                <Trash2 size={16} /> Remove unused media
              </button>
            </>
          )}
        </MenuButton>
      </div>

      <div className="ve-main">
        <div className="ve-top" style={{ height: `calc(100% - ${layout.bottom}px)` }}>
          <aside className="ve-panel" style={{ width: layout.left }}>
            <Library tab={libTab} setTab={setLibTab} onImport={importDialog} onDropFiles={dropFiles} sourceControls={sourceControls} onRelinked={() => player.reset()} />
          </aside>
          <div className="ve-split v" onPointerDown={(e) => resize('left', e)} />
          <section className="ve-panel ve-program">
            <Monitor player={player} />
          </section>
          <div className="ve-split v" onPointerDown={(e) => resize('right', e)} />
          <aside className="ve-panel ve-inspector-wrap" style={{ width: layout.right }}>
            <Inspector player={player} />
          </aside>
        </div>
        <div className="ve-split h" onPointerDown={(e) => resize('bottom', e)} />
        <div className="ve-panel ve-bottom" style={{ height: layout.bottom }}>
          <Timeline onDropFiles={dropOnTimeline} />
          {!project.clips.length && (
            <div className="ve-tl-empty">
              <Upload size={18} /> Drag media here from the bin or your desktop
            </div>
          )}
        </div>
      </div>

      <StatusBar dirty={dirty} />
      {exporting && <ExportDialog project={store.getState().project} name={tab.name} onClose={() => setExporting(false)} />}
    </div>
  );
}

/** A dropped file's path on disk ('' when it has none). */
function safePath(f: File) {
  try {
    return api.getPathForFile(f) || '';
  } catch {
    return '';
  }
}

function StatusBar({ dirty }: { dirty: boolean }) {
  const project = useVE((s) => s.project);
  const sel = useVE((s) => s.sel);
  const tool = useVE((s) => s.tool);
  const playing = useVE((s) => s.playing);
  const s = project.settings;
  const hints: Record<string, string> = {
    select: 'Drag clips to move (hold Ctrl as you drop to insert) · drag edges to trim · Alt-click picks one side of a linked pair',
    razor: 'Click a clip to cut it (Alt cuts only that side)',
    ripple: 'Drag an edge: later clips slide to close the gap',
    roll: 'Drag the edge between two clips to move the cut',
    slip: 'Drag a clip to change which part of its source plays'
  };
  return (
    <div className="statusbar">
      <span>
        {s.width} × {s.height}
      </span>
      <span>{s.fps} fps</span>
      <span>{timecode(projectDuration(project), s.fps)}</span>
      <span>
        {project.clips.length} clip{project.clips.length === 1 ? '' : 's'}
        {sel.length ? ` · ${sel.length} selected` : ''}
      </span>
      <span className="grow" />
      {!playing && <span className="ve-hint-text">{hints[tool]}</span>}
      {dirty && <span style={{ color: 'var(--accent)' }}>Unsaved changes</span>}
    </div>
  );
}

function SettingsPop({ project, set }: { project: Project; set(patch: Partial<Project['settings']>, label?: string): void }) {
  const s = project.settings;
  const [w, setW] = useState(String(s.width));
  const [h, setH] = useState(String(s.height));
  const pickAspect = (id: Aspect) => {
    const a = ASPECTS.find((x) => x.id === id)!;
    // Keep roughly the same quality: scale the preset to the current short side.
    const short = Math.min(s.width, s.height);
    const k = short / Math.min(a.w, a.h);
    const W = Math.round((a.w * k) / 2) * 2;
    const H = Math.round((a.h * k) / 2) * 2;
    setW(String(W));
    setH(String(H));
    set({ aspect: id, width: W, height: H }, 'Change aspect ratio');
  };
  const applySize = () => {
    const W = Math.round(clamp(Number(w) || s.width, 16, 7680) / 2) * 2;
    const H = Math.round(clamp(Number(h) || s.height, 16, 7680) / 2) * 2;
    set({ width: W, height: H, aspect: aspectOf(W, H) }, 'Change frame size');
  };
  return (
    <div className="ve-settings-pop" onKeyDown={(e) => e.stopPropagation()}>
      <div className="menu-title">Shape</div>
      <div className="ve-aspects">
        {ASPECTS.map((a) => (
          <button key={a.id} className={`ve-aspect ${s.aspect === a.id ? 'on' : ''}`} onClick={() => pickAspect(a.id)} title={a.label}>
            <span className="ve-aspect-box" style={{ aspectRatio: `${a.w} / ${a.h}` }} />
            {a.id}
          </button>
        ))}
      </div>
      <div className="menu-title">Frame size</div>
      <div className="ve-inline" style={{ padding: '0 12px 6px' }}>
        <input className="num-input" style={{ width: 64 }} value={w} onChange={(e) => setW(e.target.value)} onBlur={applySize} onKeyDown={(e) => e.key === 'Enter' && applySize()} />
        ×
        <input className="num-input" style={{ width: 64 }} value={h} onChange={(e) => setH(e.target.value)} onBlur={applySize} onKeyDown={(e) => e.key === 'Enter' && applySize()} />
        <span className="dim">px</span>
      </div>
      <div className="menu-title">Frame rate</div>
      <div style={{ padding: '0 12px 6px' }}>
        <select className="select ve-field" value={s.fps} onChange={(e) => set({ fps: Number(e.target.value) }, 'Change frame rate')}>
          {[...new Set([s.fps, ...FPS_CHOICES])].sort((a, b) => a - b).map((f) => (
            <option key={f} value={f}>
              {f} fps
            </option>
          ))}
        </select>
      </div>
      <div className="menu-title">Background</div>
      <div className="ve-inline" style={{ padding: '0 12px 8px' }}>
        <input type="color" className="ve-color" value={s.background} onChange={(e) => set({ background: e.target.value }, 'Background colour')} />
        <span className="dim">Shown where no clip covers the frame</span>
      </div>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause (Shift: play in to out)'],
  ['J  K  L', 'Shuttle back, stop, forward (press again for faster)'],
  ['← →', 'One frame (Shift: 10 frames)'],
  ['↑ ↓', 'Previous / next cut'],
  ['Home  End', 'Start / end'],
  ['I  O', 'Mark in / out (Alt+X clears)'],
  ['V', 'Select tool'],
  ['C', 'Razor tool'],
  ['B  N  Y', 'Ripple trim, roll and slip tools'],
  ['S', 'Snapping on / off'],
  ['Ctrl+K', 'Split at the playhead'],
  ['Delete', 'Delete (Shift: ripple delete)'],
  ['Alt+← →', 'Nudge selected clips a frame'],
  ['Ctrl+C  X  V  D', 'Copy, cut, paste, duplicate'],
  ['Ctrl+A', 'Select all'],
  ['Ctrl+L', 'Link / unlink picture and sound'],
  ['M', 'Add marker'],
  [',  .', 'Insert / overwrite from the source viewer'],
  ['+  -  \\', 'Zoom the timeline in, out, to fit'],
  ['Ctrl+Z  Ctrl+Shift+Z', 'Undo / redo'],
  ['Ctrl+T', 'Add text'],
  ['Ctrl+I', 'Import media'],
  ['Ctrl+E', 'Export (Shift: this frame as PNG)'],
  ['Alt+wheel', 'Scale the selected clip on the monitor'],
  ['Ctrl+wheel', 'Zoom the timeline']
];

function Shortcuts() {
  return (
    <div className="ve-shortcuts">
      <div className="menu-title">Keyboard shortcuts</div>
      {SHORTCUTS.map(([k, v]) => (
        <div key={k} className="ve-shortcut">
          <span className="kbd-chip">{k}</span>
          <span>{v}</span>
        </div>
      ))}
    </div>
  );
}
