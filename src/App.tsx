import { lazy, Suspense, useEffect, useState } from 'react';
import { TitleBar } from './components/TitleBar';
import { HomeScreen } from './components/Home';
import { Overlays } from './components/Overlays';
import { UpdateDialog, initUpdates } from './components/Updates';
import { useTabs, editorRegistry, Tab } from './store';
import { api } from './lib/api';
import { openEntry, openPaths, openWithDialog, newFile } from './lib/open';
import { requestCloseTab, requestQuit } from './lib/closing';
import { modKey } from './lib/util';

const PdfEditor = lazy(() => import('./editors/pdf/PdfEditor'));
const DocEditor = lazy(() => import('./editors/doc/DocEditor'));
const SheetEditor = lazy(() => import('./editors/sheet/SheetEditor'));
const CodeEditor = lazy(() => import('./editors/code/CodeEditor'));
const ImageViewer = lazy(() => import('./editors/image/ImageViewer'));

function EditorFor({ tab, active }: { tab: Tab; active: boolean }) {
  switch (tab.kind) {
    case 'pdf':
      return <PdfEditor tab={tab} active={active} />;
    case 'doc':
      return <DocEditor tab={tab} active={active} />;
    case 'sheet':
      return <SheetEditor tab={tab} active={active} />;
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
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    api.getPendingOpen().then((p) => {
      if (p.length) openPaths(p);
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
      if (!modKey(e)) return;
      const k = e.key.toLowerCase();
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
        newFile('doc');
      } else if (k === 'w') {
        e.preventDefault();
        requestCloseTab(activeId);
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
      <div className="workspace">
        {tabs.map((t) => (
          <div key={`${t.id}:${t.version}`} className="pane" hidden={t.id !== activeId}>
            {t.kind === 'home' ? (
              <HomeScreen visible={t.id === activeId} />
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
      </div>
      {dragging && (
        <div className="drop-overlay">
          <div>Drop to open</div>
        </div>
      )}
      <UpdateDialog />
      <Overlays />
    </div>
  );
}
