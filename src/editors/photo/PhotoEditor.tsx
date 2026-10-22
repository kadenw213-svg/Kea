import { useEffect, useRef, useState } from 'react';
import { Save, Undo2, Redo2, ZoomIn, ZoomOut, Maximize, Layers as LayersIcon, History as HistoryIcon, SlidersHorizontal, Settings2 } from 'lucide-react';
import type { Tab, AiHooks } from '../../store';
import { editorRegistry, setDirty, toast, useTabs, ask, proxyAi } from '../../store';
import { saveTabFile, isSilentSave, SaveFormat } from '../../lib/save';
import { extOf, baseName } from '../../lib/fileTypes';
import { imagesToPdf } from '../../lib/pdfTools';
import { api } from '../../lib/api';
import { Engine } from './engine';
import type { ToolId } from './toolOptions';
import { TOOL_GROUPS, TOOL_NAMES, brushKey } from './toolOptions';
import { decodeFile, decodeToCanvas, blankDoc, encode, isLayered, OPENABLE } from './io';
import { Viewport, isTyping } from './Viewport';
import { ToolStrip, OptionsBar, selectTool } from './chrome';
import { MenuBar, Commands } from './menus';
import { LayersPanel, PropertiesPanel, AdjustmentsPanel, HistoryPanel, DockSection } from './panels';
import { PhotoDialog, DialogSpec, lastFilterRun } from './dialogs';
import { adjDefaults } from './adjustments';
import { photoAi } from './ai';
import * as ops from './ops';
import * as T from './tools';
import { canvasToBytes } from './canvas';
import { selectionArea } from './selection';
import './photo.css';
import { LookupButton } from '../../components/lookup/LookupButton';
import { AssistantButton } from '../../components/assistant/AssistantPanel';

/**
 * Kea's photo editor: a layered, Photoshop-style image editor (open PNG/JPEG/WebP/
 * GIF/BMP/SVG/PSD, save flat images or layered PSD). The document lives in an Engine;
 * React renders the chrome around it and re-renders when the engine emits.
 */
export default function PhotoEditor({ tab, active }: { tab: Tab; active: boolean }) {
  const [engine, setEngine] = useState<Engine | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const doc = tab.data && tab.data.length ? await decodeFile(tab.name, tab.data) : blankDoc(1920, 1080, 'white');
        if (!dead) setEngine(new Engine(doc, tab.data ? 'Open' : 'New image'));
      } catch (err: any) {
        if (!dead) setError(err?.message || String(err));
      }
    })();
    return () => {
      dead = true;
    };
  }, []);
  if (error)
    return (
      <div className="center-fill">
        <div className="empty-note">
          Couldn't open this image: {error}
          <br />
          Supported: {OPENABLE.map((x) => x.toUpperCase()).join(', ')}.
        </div>
      </div>
    );
  if (!engine)
    return (
      <div className="center-fill">
        <div className="spinner" />
      </div>
    );
  return <Workspace tab={tab} active={active} e={engine} />;
}

const SECTIONS_KEY = 'kea.photo.sections';
function loadSections(): Record<string, boolean> {
  try {
    return { props: true, adjust: false, layers: true, history: true, ...JSON.parse(localStorage.getItem(SECTIONS_KEY) || '{}') };
  } catch {
    return { props: true, adjust: false, layers: true, history: true };
  }
}

function Workspace({ tab, active, e }: { tab: Tab; active: boolean; e: Engine }) {
  const [, force] = useState(0);
  const [dialog, setDialog] = useState<DialogSpec | null>(null);
  const [sections, setSections] = useState(loadSections);
  const flattenOk = useRef(false);
  const tabRef = useRef(tab);
  tabRef.current = tab;

  useEffect(() => e.subscribe(() => force((n) => n + 1)), [e]);
  useEffect(() => {
    e.onChange = () => setDirty(tab.id, e.dirty);
    return () => {
      e.onChange = null;
    };
  }, [e, tab.id]);

  const toggleSection = (id: string) =>
    setSections((s) => {
      const next = { ...s, [id]: !s[id] };
      try {
        localStorage.setItem(SECTIONS_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable */
      }
      return next;
    });

  const act = (fn: () => unknown) => {
    try {
      const r = fn();
      if (r instanceof Promise) r.catch((err) => toast(err?.message || String(err), 'error'));
    } catch (err: any) {
      toast(err?.message || String(err), 'error');
    }
  };

  /** Finish anything half-done (typing, transform) before saving or exporting. */
  const settle = () => {
    if (e.textEditing) T.endText(e);
    if (e.transform) ops.commitTransform(e);
  };

  // ---------- Saving ----------
  const quality = 0.92;
  const formats = (first?: string): SaveFormat[] => {
    const all: SaveFormat[] = [
      { name: 'PNG image', ext: 'png', build: () => encode(e, 'png') },
      { name: 'JPEG image', ext: 'jpg', build: () => encode(e, 'jpg', quality) },
      { name: 'WebP image', ext: 'webp', build: () => encode(e, 'webp', quality) },
      { name: 'Photoshop document (keeps layers)', ext: 'psd', build: () => encode(e, 'psd') }
    ];
    const ext = first || extOf(tabRef.current.path || tabRef.current.name);
    const cur = ext === 'jpeg' ? { ...all[1], ext: 'jpeg' } : all.find((f) => f.ext === ext);
    return cur ? [cur, ...all.filter((f) => f.ext !== cur.ext && !(cur.ext === 'jpeg' && f.ext === 'jpg'))] : all;
  };
  const doSave = async (list: SaveFormat[], saveAs: boolean) => {
    const ok = await saveTabFile(tab.id, list, saveAs);
    if (ok) e.markSaved();
    return ok;
  };
  const save = async (saveAs: boolean): Promise<boolean> => {
    settle();
    const t = tabRef.current;
    const ext = extOf(t.path || t.name);
    if (!saveAs && !e.dirty && t.path) return true;
    // Flat formats can't hold layers: offer PSD (once per session) unless it's already a PSD.
    if (!saveAs && ext !== 'psd' && isLayered(e.doc) && !flattenOk.current) {
      if (isSilentSave()) return false;
      const EXT = (['png', 'jpg', 'jpeg', 'webp'].includes(ext) ? ext : 'png').toUpperCase();
      const choice = await ask(
        'Keep your layers?',
        `This image has layers, masks, text or adjustments. A ${EXT} file can only hold the flattened picture. Save a Photoshop (PSD) file to keep everything editable, or save a flattened ${EXT} (your layers stay here until you close the tab).`,
        [
          { id: 'cancel', label: 'Cancel' },
          { id: 'flat', label: `Save flattened ${EXT}` },
          { id: 'psd', label: 'Save as PSD', primary: true }
        ]
      );
      if (choice === 'psd') return doSave(formats('psd'), true);
      if (choice !== 'flat') return false;
      flattenOk.current = true;
    }
    return doSave(formats(), saveAs);
  };

  const pngBytes = async () => {
    settle();
    return canvasToBytes(e.flush(), 'image/png');
  };
  const print = async () => {
    const bytes = await pngBytes();
    const b64 = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
    await api.printHtml(`<!doctype html><html><head><style>@page{margin:0.5in}body{margin:0;display:flex;justify-content:center}img{max-width:100%;max-height:100vh}</style></head><body><img src="data:image/png;base64,${b64}"></body></html>`);
  };

  const aiRef = useRef<AiHooks>(null as any);
  if (!aiRef.current) aiRef.current = photoAi(e);
  const handlers = useRef({ save, print });
  handlers.current = { save, print };
  useEffect(() => {
    editorRegistry.set(tab.id, {
      save: (a) => handlers.current.save(a),
      print: () => handlers.current.print(),
      debugBuild: () => encode(e, extOf(tabRef.current.name) || 'png'),
      ai: proxyAi(aiRef)
    });
  }, [tab.id]);

  const cmd: Commands = {
    save: () => act(() => save(false)),
    saveAs: () => act(() => save(true)),
    print: () => act(print),
    dialog: (d) => setDialog(d.kind === 'export' ? { ...d, tabName: tabRef.current.name } : d),
    lastFilter: () => act(() => lastFilterRun && ops.applyFilter(e, lastFilterRun)),
    place: () =>
      act(async () => {
        const files = await api.openDialog({ title: 'Place image', filters: [{ name: 'Images', extensions: OPENABLE }] });
        for (const f of files) {
          const c = await decodeToCanvas(f.name, f.data);
          ops.placeImage(e, c, baseName(f.name));
        }
      }),
    copyImage: () =>
      act(async () => {
        const bytes = await pngBytes();
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes as BlobPart], { type: 'image/png' }) })]);
        toast('Image copied', 'success');
      }),
    makePdf: () =>
      act(async () => {
        const pdf = await imagesToPdf([{ path: '', name: 'image.png', data: await pngBytes() }]);
        useTabs.getState().addTab({ kind: 'pdf', name: `${baseName(tabRef.current.name)}.pdf`, path: null, data: pdf });
      })
  };

  // ---------- Keyboard ----------
  useEffect(() => {
    if (!active) return;
    const onKey = (ev: KeyboardEvent) => {
      if (isTyping(ev) || dialog) return;
      const k = ev.key;
      const mod = ev.ctrlKey || ev.metaKey;
      const stop = () => {
        ev.preventDefault();
        ev.stopPropagation();
      };
      if (T.toolKey(e, ev)) return stop();
      if (mod) {
        const lower = k.toLowerCase();
        const run = (fn: () => unknown) => {
          stop();
          act(fn);
        };
        if (lower === 'z') return run(() => (ev.shiftKey ? e.redo() : e.undo()));
        if (lower === 'y') return run(() => e.redo());
        if (lower === 'a') return run(() => ops.selectAll(e));
        if (lower === 'd') return run(() => ops.deselect(e));
        if (lower === 'i' && ev.shiftKey) return run(() => ops.invertSelection(e));
        if (lower === 'i' && ev.altKey) return run(() => setDialog({ kind: 'imageSize' }));
        if (lower === 'i') return run(() => ops.applyAdjustmentPixels(e, adjDefaults('invert')));
        if (lower === 'c' && ev.altKey) return run(() => setDialog({ kind: 'canvasSize' }));
        if (lower === 't') return run(() => ops.beginTransform(e));
        // (Ctrl+Shift+J is Kea's Claude panel.)
        if (lower === 'j' && !ev.shiftKey) return run(() => (e.selection && e.active && e.active.kind !== 'group' ? viaCopy(e) : ops.duplicateLayer(e)));
        if (lower === 'n' && ev.shiftKey) return run(() => ops.addLayer(e));
        if (lower === 'e') return run(() => (ev.shiftKey ? ops.mergeVisible(e) : ops.mergeDown(e)));
        if (lower === 'g' && ev.altKey) return run(() => ops.toggleClip(e));
        if (lower === 'g') return run(() => (ev.shiftKey ? ops.ungroup(e) : ops.groupActive(e)));
        if (lower === 'c') return run(() => ops.copy(e, ev.shiftKey));
        if (lower === 'x') return run(() => ops.cut(e));
        if (lower === 'v') return run(() => ops.paste(e));
        if (lower === 'l') return run(() => setDialog({ kind: 'adjust', type: 'levels' }));
        if (lower === 'm') return run(() => setDialog({ kind: 'adjust', type: 'curves' }));
        if (lower === 'u' && ev.shiftKey) return run(() => ops.applyAdjustmentPixels(e, { ...adjDefaults('hueSat'), saturation: -100 }));
        if (lower === 'u') return run(() => setDialog({ kind: 'adjust', type: 'hueSat' }));
        if (lower === 'b') return run(() => setDialog({ kind: 'adjust', type: 'colorBalance' }));
        if (lower === 'f' && ev.shiftKey) return run(() => ops.canFade(e) && setDialog({ kind: 'fade' }));
        if (lower === 'f' && ev.altKey) return run(cmd.lastFilter);
        if (k === '=' || k === '+') return run(() => e.zoomStep(1));
        if (k === '-') return run(() => e.zoomStep(-1));
        if (k === '0') return run(() => e.fitView());
        if (k === '1') return run(() => e.zoomTo(1));
        if (k === "'") return run(() => ((e.showGrid = !e.showGrid), e.requestFrame(), e.emit()));
        if (lower === 'r') return run(() => ((e.showRulers = !e.showRulers), e.requestFrame(), e.emit()));
        if (lower === 'h') return run(() => ((e.showSelection = !e.showSelection), e.requestFrame(), e.emit()));
        if (k === ']') return run(() => ops.shiftOrder(e, 1));
        if (k === '[') return run(() => ops.shiftOrder(e, -1));
        if (lower === 'w' && ev.altKey && ev.shiftKey) return run(() => cmd.dialog({ kind: 'export', tabName: '' }));
        return; // Leave Ctrl+S, Ctrl+P, Ctrl+W… to the app.
      }
      if (ev.altKey && !mod) {
        // Keep Alt (used by tools) from focusing the window menu.
        if (k === 'Alt') ev.preventDefault();
      }
      // Delete clears the selection (or deletes the layer when nothing is selected); Backspace only clears.
      if (k === 'Delete' || (k === 'Backspace' && e.selection)) return (stop(), act(() => ops.clearSelected(e)));
      if (k === 'F5' && ev.shiftKey) return (stop(), setDialog({ kind: 'fill' }));
      if (k === 'F6' && ev.shiftKey) return (stop(), e.selection && setDialog({ kind: 'modify', op: 'feather' }));
      if (k.startsWith('Arrow') && e.tool === 'move') {
        stop();
        const d = ev.shiftKey ? 10 : 1;
        const dx = k === 'ArrowLeft' ? -d : k === 'ArrowRight' ? d : 0;
        const dy = k === 'ArrowUp' ? -d : k === 'ArrowDown' ? d : 0;
        return act(() => {
          if (e.selection && e.active && e.active.kind === 'raster') {
            ops.beginTransform(e, true);
            e.transform!.cx += dx;
            e.transform!.cy += dy;
            return ops.commitTransform(e);
          }
          const l = e.active;
          if (!l || l.locked) return;
          ops.offsetLayer(l, dx, dy);
          e.commit('Nudge');
        });
      }
      if (ev.altKey || ev.shiftKey ? false : k === '[' || k === ']') {
        const size = T.brushSizeOf(e);
        if (size) {
          stop();
          T.setBrushSize(e, k === ']' ? Math.max(size + 1, size * 1.15) : Math.min(size - 1, size / 1.15));
        }
        return;
      }
      if (/^[0-9]$/.test(k) && brushKey(e.tool)) {
        // Number keys set the painting opacity (1 = 10% … 0 = 100%).
        stop();
        const key = brushKey(e.tool)!;
        const v = k === '0' ? 1 : parseInt(k) / 10;
        e.opts[key] = { ...(e.opts[key] as any), opacity: v };
        toast(`Opacity ${Math.round(v * 100)}%`);
        e.emit();
        return;
      }
      const lower = k.toLowerCase();
      if (lower === 'x' && !ev.shiftKey) return (stop(), ([e.fg, e.bg] = [e.bg, e.fg]), e.emit());
      if (lower === 'd' && !ev.shiftKey) return (stop(), (e.fg = '#000000'), (e.bg = '#ffffff'), e.emit());
      const group = TOOL_GROUPS.find((g) => g.key.toLowerCase() === lower);
      if (group) {
        stop();
        let next: ToolId;
        if (group.tools.includes(e.tool)) next = ev.shiftKey ? group.tools[(group.tools.indexOf(e.tool) + 1) % group.tools.length] : e.tool;
        else next = lastTool.current[group.key] || group.tools[0];
        lastTool.current[group.key] = next;
        selectTool(e, next);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  const lastTool = useRef<Record<string, ToolId>>({});

  const zoomPct = Math.round(e.view.zoom * 1000) / 10;
  return (
    <div className="photo-editor">
      <div className="toolbar ph-topbar">
        <MenuBar e={e} cmd={cmd} />
        <div className="tb-sep" />
        <button className="icon-btn" title="Undo (Ctrl+Z)" disabled={!e.history.canUndo && !e.transform} onClick={() => e.undo()}>
          <Undo2 size={18} />
        </button>
        <button className="icon-btn" title="Redo (Ctrl+Shift+Z)" disabled={!e.history.canRedo} onClick={() => e.redo()}>
          <Redo2 size={18} />
        </button>
        <div className="tb-sep" />
        <button className="icon-btn" title="Zoom out (Ctrl+-)" onClick={() => e.zoomStep(-1)}>
          <ZoomOut size={18} />
        </button>
        <button className="zoom-label ph-zoom" onClick={() => (e.view.fit ? e.zoomTo(1) : e.fitView())} title="Toggle fit / 100%">
          {zoomPct}%
        </button>
        <button className="icon-btn" title="Zoom in (Ctrl++)" onClick={() => e.zoomStep(1)}>
          <ZoomIn size={18} />
        </button>
        <button className={`icon-btn ${e.view.fit ? 'active' : ''}`} title="Fit on screen (Ctrl+0)" onClick={() => e.fitView()}>
          <Maximize size={18} />
        </button>
        <div className="tb-spacer" />
        <LookupButton />
        <AssistantButton />
        <button className="btn primary sm" onClick={cmd.save} disabled={!e.dirty && !!tab.path} title="Save (Ctrl+S)">
          <Save size={16} /> Save
        </button>
      </div>
      <OptionsBar e={e} openDialog={(d) => setDialog(d)} />
      <div className="ph-body">
        <ToolStrip e={e} />
        <Viewport engine={e} active={active} />
        <div className="ph-dock">
          <DockSection id="props" title="Properties" icon={<Settings2 size={14} />} open={sections.props} onToggle={toggleSection}>
            <PropertiesPanel e={e} />
          </DockSection>
          <DockSection id="adjust" title="Adjustments" icon={<SlidersHorizontal size={14} />} open={sections.adjust} onToggle={toggleSection}>
            <AdjustmentsPanel e={e} />
          </DockSection>
          <DockSection id="layers" title="Layers" icon={<LayersIcon size={14} />} open={sections.layers} onToggle={toggleSection} grow>
            <LayersPanel e={e} />
          </DockSection>
          <DockSection id="history" title="History" icon={<HistoryIcon size={14} />} open={sections.history} onToggle={toggleSection}>
            <HistoryPanel e={e} />
          </DockSection>
        </div>
      </div>
      <StatusBar e={e} />
      {dialog && <PhotoDialog spec={dialog} engine={e} close={() => setDialog(null)} />}
    </div>
  );
}

/** Ctrl+J with a selection: copy the selected pixels to a new layer in place. */
function viaCopy(e: Engine) {
  ops.copy(e);
  const c = e.clipboard!;
  const l = e.newRaster(e.uniqueName('Layer'), c.canvas, c.x, c.y);
  e.insert(l);
  e.state.selection = null;
  e.editTarget = 'pixels';
  e.commit('Layer via copy');
}

function StatusBar({ e }: { e: Engine }) {
  const [, force] = useState(0);
  useEffect(() => e.subscribeCursor(() => force((n) => n + 1)), [e]);
  const c = e.cursor;
  return (
    <div className="statusbar ph-status">
      <span>
        {e.doc.w} × {e.doc.h} px
      </span>
      <span>{Math.round(e.view.zoom * 1000) / 10}%</span>
      <span className="ph-pos">{c.inside ? `${c.x}, ${c.y}` : '–'}</span>
      {c.inside && c.color && (
        <span className="ph-pos">
          <span className="ph-dot" style={{ background: c.color }} /> {c.color}
        </span>
      )}
      <span>{TOOL_NAMES[e.tool]}</span>
      {e.selection && <span>Selection {selectionArea(e.selection)}</span>}
      {e.editTarget === 'mask' && <span style={{ color: 'var(--warning)' }}>Painting on mask</span>}
      <span className="grow" />
      {e.dirty && <span style={{ color: 'var(--accent)' }}>Edited · save to keep changes</span>}
    </div>
  );
}
