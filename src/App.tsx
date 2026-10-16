import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { TitleBar } from './components/TitleBar';
import { HomeScreen } from './components/Home';
import { Overlays } from './components/Overlays';
import { UpdateDialog, initUpdates } from './components/Updates';
import { LookupPanel } from './components/lookup/LookupPanel';
import { SettingsDialog } from './components/settings/SettingsDialog';
import { VersionHistoryDialog, openHistory } from './components/settings/VersionHistory';
import { openSettings, setting } from './lib/settings';
import { initAutosave, restoreOnStart } from './lib/autosave';
import { CommandPalette, openPalette } from './components/CommandPalette';
import { toggleLookup } from './components/lookup/lookupStore';
import { useTabs, editorRegistry, Tab } from './store';
import { api } from './lib/api';
import { openEntry, openPaths, openWithDialog, newFile } from './lib/open';
import { requestCloseTab, requestQuit } from './lib/closing';
import { modKey } from './lib/util';
import { VoiceTypingPanel, toggleVoice } from './components/VoiceTyping';

const PdfEditor = lazy(() => import('./editors/pdf/PdfEditor'));
const ScholarScreen = lazy(() => import('./components/scholar/ScholarScreen').then((m) => ({ default: m.ScholarScreen })));
const DocEditor = lazy(() => import('./editors/doc/DocEditor'));
const SheetEditor = lazy(() => import('./editors/sheet/SheetEditor'));
const CodeEditor = lazy(() => import('./editors/code/CodeEditor'));
const SlidesEditor = lazy(() => import('./editors/slides/SlidesEditor'));
const ImageViewer = lazy(() => import('./editors/image/ImageViewer'));

function EditorFor({ tab, active }: { tab: Tab; active: boolean }) {
  switch (tab.kind) {
    case 'pdf':
      return <PdfEditor tab={tab} active={active} />;
    case 'doc':
      return <DocEditor tab={tab} active={active} />;
    case 'sheet':
      return <SheetEditor tab={tab} active={active} />;
    case 'slides':
      return <SlidesEditor tab={tab} active={active} />;
    case 'code':
      return <CodeEditor tab={tab} active={active} />;
    case 'image':
      return <ImageViewer tab={tab} active={active} />;
    default:
      return null;
  }
}

export function App() {
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const split = useTabs((s) => s.split);
  const [dragging, setDragging] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const startDivider = (e: React.PointerEvent) => {
    e.preventDefault();
    const box = workspaceRef.current!.getBoundingClientRect();
    document.body.classList.add('col-resizing');
    const move = (ev: PointerEvent) => useTabs.getState().setSplitRatio((ev.clientX - box.left) / box.width);
    const up = () => {
      document.body.classList.remove('col-resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const paneStyle = (id: string): React.CSSProperties | undefined => {
    if (!split) return undefined;
    if (id === split.left) return { right: `calc(${(1 - split.ratio) * 100}% + 3px)` };
    if (id === split.right) return { left: `calc(${split.ratio * 100}% + 3px)` };
    return undefined;
  };

  useEffect(() => {
    initAutosave();
    api.getPendingOpen().then(async (p) => {
      if (p.length) await openPaths(p);
      await restoreOnStart(p.length > 0);
    });
    const offOpen = api.onOpenPaths((p) => openPaths(p));
    const offClose = api.onBeforeClose(() => requestQuit());
    initUpdates();
    return () => {
      offOpen();
      offClose();
    };
  }, []);

  // Global shortcuts. Capture phase so they work inside editors too.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Command palette: Ctrl+Shift+P or Alt+/
      if ((modKey(e) && e.shiftKey && e.key.toLowerCase() === 'p') || (e.altKey && !e.ctrlKey && e.key === '/')) {
        e.preventDefault();
        e.stopPropagation();
        openPalette();
        return;
      }
      if (!modKey(e)) return;
      const k = e.key.toLowerCase();
      if (e.altKey && !e.shiftKey && (k === 'v' || e.code === 'KeyV')) {
        e.preventDefault();
        e.stopPropagation();
        toggleVoice();
        return;
      }
      if (k === ',') {
        e.preventDefault();
        openSettings();
        return;
      }
      if (k === 'h' && e.shiftKey) {
        e.preventDefault();
        openHistory();
        return;
      }
      const { activeId, tabs, setActive } = useTabs.getState();
      const handle = editorRegistry.get(activeId);
      if (k === 's') {
        e.preventDefault();
        handle?.save(e.shiftKey);
      } else if (k === 'o') {
        e.preventDefault();
        openWithDialog();
      } else if (k === 'n' && !e.shiftKey) {
        e.preventDefault();
        newFile(setting('general.newKind') || 'doc');
      } else if (k === 'w') {
        e.preventDefault();
        requestCloseTab(activeId);
      } else if (k === 'j' && !e.shiftKey) {
        e.preventDefault();
        toggleLookup();
      } else if (k === '\\') {
        e.preventDefault();
        const st = useTabs.getState();
        if (st.split) st.closeSplit();
        else st.openSplit();
      } else if (k === 'p') {
        e.preventDefault();
        handle?.print?.();
      } else if (k === 'tab') {
        e.preventDefault();
        const i = tabs.findIndex((t) => t.id === activeId);
        const next = (i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length;
        setActive(tabs[next].id);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // Mouse wheel scrolls toolbars sideways when they're wider than the window.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      const bar = (e.target as HTMLElement)?.closest?.('.toolbar') as HTMLElement | null;
      if (!bar || bar.scrollWidth <= bar.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      bar.scrollLeft += e.deltaY;
    };
    window.addEventListener('wheel', onWheel, { passive: true });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);

  // Drop files anywhere to open them.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      // Editors that accept file drops (e.g. images into a PDF) stop propagation themselves.
      e.preventDefault();
      depth = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer!.files);
      for (const f of files) {
        const p = api.getPathForFile(f);
        if (p) await openPaths([p]);
        else await openEntry({ path: '', name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
      }
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, []);

  return (
    <div className="app">
      <TitleBar />
      <div className="workspace-row">
      <div className={`workspace ${split ? 'is-split' : ''}`} ref={workspaceRef}>
        {tabs.map((t) => (
          <div
            key={`${t.id}:${t.version}`}
            className={`pane ${split && t.id === activeId ? 'focused' : ''}`}
            hidden={t.id !== activeId && !(split && (t.id === split.left || t.id === split.right))}
            style={paneStyle(t.id)}
            onPointerDownCapture={() => split && t.id !== activeId && useTabs.getState().setActive(t.id)}
          >
            {t.kind === 'home' ? (
              <HomeScreen visible={t.id === activeId || !!(split && (t.id === split.left || t.id === split.right))} />
            ) : t.kind === 'scholar' ? (
              <Suspense
                fallback={
                  <div className="center-fill">
                    <div className="spinner" />
                  </div>
                }
              >
                <ScholarScreen />
              </Suspense>
            ) : (
              <Suspense
                fallback={
                  <div className="center-fill">
                    <div className="spinner" />
                  </div>
                }
              >
                <EditorFor tab={t} active={t.id === activeId} />
              </Suspense>
            )}
          </div>
        ))}
        {split && (
          <div className="split-divider" style={{ left: `calc(${split.ratio * 100}% - 3px)` }} onPointerDown={startDivider} onDoubleClick={() => useTabs.getState().setSplitRatio(0.5)} title="Drag to resize · double-click to even out">
            <button className="split-close" title="Close split view (Ctrl+\)" onPointerDown={(e) => e.stopPropagation()} onClick={() => useTabs.getState().closeSplit()}>
              <X size={12} />
            </button>
          </div>
        )}
      </div>
      <LookupPanel />
      </div>
      {dragging && (
        <div className="drop-overlay">
          <div>Drop to open</div>
        </div>
      )}
      <UpdateDialog />
      <SettingsDialog />
      <CommandPalette />
      <VoiceTypingPanel />
      <VersionHistoryDialog />
      <Overlays />
    </div>
  );
}
