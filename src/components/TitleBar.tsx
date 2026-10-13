import { useRef } from 'react';
import { Home, Plus, X } from 'lucide-react';
import { useTabs } from '../store';
import { FileIcon } from './FileIcon';
import { MenuButton } from './Popover';
import { newFile, openWithDialog } from '../lib/open';
import { FileText, Sheet, FileCode2, FolderOpen, Presentation } from 'lucide-react';
import { requestCloseTab } from '../lib/closing';
import { isMac } from '../lib/util';
import { useUpdates, openUpdates } from './Updates';
import { RefreshCw, Info, Github, Sparkles } from 'lucide-react';
import { useAi } from './ai/aiStore';

export function TitleBar() {
  const { tabs, activeId, setActive, moveTab } = useTabs();
  const dragFrom = useRef<number | null>(null);
  const upd = useUpdates();
  const hasUpdate = ['available', 'downloading', 'ready'].includes(upd.state.status);

  return (
    <div className={`titlebar ${isMac() ? 'mac' : ''}`}>
      {!isMac() && (
        <MenuButton
          title="Slate Office menu"
          button={() => (
            <button className="brand">
              <div className="brand-mark">S</div>
              {hasUpdate && <span className="update-dot" />}
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="menu-title">Slate Office {upd.version}</div>
              <button className="menu-item" onClick={() => (openUpdates(), close())}>
                <RefreshCw size={16} /> {hasUpdate ? 'Update available' : 'Check for updates'}
                {hasUpdate && <span className="kbd" style={{ color: 'var(--accent)' }}>●</span>}
              </button>
              <button className="menu-item" onClick={() => (useAi.getState().set({ settingsOpen: true }), close())}>
                <Sparkles size={16} /> AI settings
              </button>
              <div className="menu-sep" />
              <button className="menu-item" onClick={() => (newFile('doc'), close())}>
                <FileText size={16} color="#8ab4f8" /> New document <span className="kbd">Ctrl+N</span>
              </button>
              <button className="menu-item" onClick={() => (newFile('sheet'), close())}>
                <Sheet size={16} color="#81c995" /> New spreadsheet
              </button>
              <button className="menu-item" onClick={() => (newFile('slides'), close())}>
                <Presentation size={16} color="#fcad70" /> New presentation
              </button>
              <button className="menu-item" onClick={() => (openWithDialog(), close())}>
                <FolderOpen size={16} /> Open file… <span className="kbd">Ctrl+O</span>
              </button>
              <div className="menu-sep" />
              <button className="menu-item" onClick={() => (window.open('https://github.com/kadenw213-svg/slate-office'), close())}>
                <Github size={16} /> Source code on GitHub
              </button>
              <button className="menu-item" onClick={() => (window.open('https://github.com/kadenw213-svg/slate-office/releases'), close())}>
                <Info size={16} /> Release notes
              </button>
            </>
          )}
        </MenuButton>
      )}
      <div className="tabs">
        {tabs.map((t, i) => (
          <div
            key={t.id}
            className={`tab ${t.id === activeId ? 'active' : ''}`}
            onMouseDown={(e) => {
              if (e.button === 1) {
                e.preventDefault();
                requestCloseTab(t.id);
              } else setActive(t.id);
            }}
            draggable={t.kind !== 'home'}
            onDragStart={(e) => {
              dragFrom.current = i;
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('application/x-slate-tab', String(i));
            }}
            onDragOver={(e) => {
              if (dragFrom.current !== null) e.preventDefault();
            }}
            onDrop={(e) => {
              if (dragFrom.current !== null && dragFrom.current !== i) moveTab(dragFrom.current, i);
              dragFrom.current = null;
            }}
            onDragEnd={() => (dragFrom.current = null)}
            title={t.path || t.name}
          >
            {t.kind === 'home' ? <Home size={16} /> : <FileIcon name={t.name} kind={t.kind} size={15} />}
            {t.kind !== 'home' && <span className="tab-label">{t.name}</span>}
            {t.kind !== 'home' && (
              <button
                className={`tab-close ${t.dirty ? 'has-dirty' : ''}`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  requestCloseTab(t.id);
                }}
                title="Close (Ctrl+W)"
              >
                {t.dirty && <span className="tab-dirty" />}
                <X size={14} />
              </button>
            )}
          </div>
        ))}
        <MenuButton
          title="New"
          button={() => (
            <button className="icon-btn sm new-tab">
              <Plus size={18} />
            </button>
          )}
        >
          {(close) => (
            <>
              <button className="menu-item" onClick={() => (newFile('doc'), close())}>
                <FileText size={16} color="#8ab4f8" /> Document <span className="kbd">Ctrl+N</span>
              </button>
              <button className="menu-item" onClick={() => (newFile('sheet'), close())}>
                <Sheet size={16} color="#81c995" /> Spreadsheet
              </button>
              <button className="menu-item" onClick={() => (newFile('slides'), close())}>
                <Presentation size={16} color="#fcad70" /> Presentation
              </button>
              <button className="menu-item" onClick={() => (newFile('code'), close())}>
                <FileCode2 size={16} color="#c58af9" /> Text file
              </button>
              <div className="menu-sep" />
              <button className="menu-item" onClick={() => (openWithDialog(), close())}>
                <FolderOpen size={16} /> Open file… <span className="kbd">Ctrl+O</span>
              </button>
            </>
          )}
        </MenuButton>
      </div>
    </div>
  );
}
