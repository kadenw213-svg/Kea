import { Logo } from './Logo';
import { useRef, useState } from 'react';
import { Popover } from './Popover';
import { Columns2, PanelRightClose, XSquare } from 'lucide-react';
import { Home, Plus, X, GraduationCap, Briefcase } from 'lucide-react';
import { useAreas, useSetupDone } from '../lib/areas';
import { openScholar } from './scholar/scholarStore';
import { openWork } from './work/workStore';
import { useTabs } from '../store';
import { FileIcon } from './FileIcon';
import { MenuButton } from './Popover';
import { newFile, openWithDialog } from '../lib/open';
import { FileText, Sheet, FileCode2, FolderOpen, Presentation } from 'lucide-react';
import { requestCloseTab } from '../lib/closing';
import { isMac } from '../lib/util';
import { useUpdates, openUpdates } from './Updates';
import { RefreshCw, Info, Github, BookOpen } from 'lucide-react';
import { openSettings } from '../lib/settings';
import { openPalette } from './CommandPalette';
import { Search } from 'lucide-react';
import { openHistory } from './settings/VersionHistory';
import { Settings as SettingsIcon, History } from 'lucide-react';

export function TitleBar() {
  const { tabs, activeId, setActive, moveTab, split } = useTabs();
  const dragFrom = useRef<number | null>(null);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [tabMenuAnchor, setTabMenuAnchor] = useState<HTMLDivElement | null>(null);
  const closeTabMenu = () => (setTabMenu(null), setTabMenuAnchor(null));
  const inSplit = (id: string) => !!split && (split.left === id || split.right === id);
  const upd = useUpdates();
  const hasUpdate = ['available', 'downloading', 'ready'].includes(upd.state.status);

  return (
    <div className={`titlebar ${isMac() ? 'mac' : ''}`}>
      {!isMac() && (
        <MenuButton
          title="Kea menu"
          button={() => (
            <button className="brand">
              <Logo size={22} />
              {hasUpdate && <span className="update-dot" />}
            </button>
          )}
        >
          {(close) => (
            <>
              <div className="menu-title">Kea {upd.version}</div>
              <button className="menu-item" onClick={() => (openUpdates(), close())}>
                <RefreshCw size={16} /> {hasUpdate ? 'Update available' : 'Check for updates'}
                {hasUpdate && <span className="kbd" style={{ color: 'var(--accent)' }}>●</span>}
              </button>
              <button className="menu-item" onClick={() => (openPalette(), close())}>
                <Search size={16} /> Search everything <span className="kbd">Ctrl+Shift+P</span>
              </button>
              <button className="menu-item" onClick={() => (openSettings(), close())}>
                <SettingsIcon size={16} /> Settings <span className="kbd">Ctrl+,</span>
              </button>
              <button className="menu-item" onClick={() => (openHistory(), close())}>
                <History size={16} /> Version history <span className="kbd">Ctrl+Shift+H</span>
              </button>
              <button className="menu-item" onClick={() => (openSettings('lookup'), close())}>
                <BookOpen size={16} /> Encyclopedia settings
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
              <button className="menu-item" onClick={() => (window.open('https://github.com/kadenw213-svg/kea'), close())}>
                <Github size={16} /> Source code on GitHub
              </button>
              <button className="menu-item" onClick={() => (window.open('https://github.com/kadenw213-svg/kea/releases'), close())}>
                <Info size={16} /> Release notes
              </button>
            </>
          )}
        </MenuButton>
      )}
      <AreaButtons />
      <div className="tabs">
        {tabs.map((t, i) => (
          <div
            key={t.id}
            className={`tab ${t.id === activeId ? 'active' : ''} ${inSplit(t.id) && t.id !== activeId ? 'split-other' : ''}`}
            onContextMenu={(e) => {
              e.preventDefault();
              setTabMenu({ x: e.clientX, y: e.clientY, id: t.id });
            }}
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
              e.dataTransfer.setData('application/x-kea-tab', String(i));
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
            {t.kind === 'home' ? <Home size={16} /> : t.kind === 'scholar' ? <GraduationCap size={15} /> : t.kind === 'work' ? <Briefcase size={15} /> : <FileIcon name={t.name} kind={t.kind} size={15} />}
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
      {tabMenu && (
        <>
          <div ref={setTabMenuAnchor} style={{ position: 'fixed', left: tabMenu.x, top: tabMenu.y, width: 1, height: 1 }} />
          <Popover anchor={tabMenuAnchor} open={!!tabMenuAnchor} onClose={closeTabMenu}>
            {inSplit(tabMenu.id) ? (
              <button className="menu-item" onClick={() => (useTabs.getState().closeSplit(), closeTabMenu())}>
                <PanelRightClose size={16} /> Close split view
              </button>
            ) : (
              tabMenu.id !== activeId && (
                <button className="menu-item" onClick={() => (useTabs.getState().closeSplit(), useTabs.getState().openSplit(tabMenu.id), closeTabMenu())}>
                  <Columns2 size={16} /> Open beside {tabs.find((x) => x.id === activeId)?.kind === 'home' ? 'Home' : 'this tab'}
                  <span className="kbd">Ctrl+\</span>
                </button>
              )
            )}
            {tabMenu.id === activeId && !split && tabs.length > 1 && (
              <button className="menu-item" onClick={() => (useTabs.getState().openSplit(), closeTabMenu())}>
                <Columns2 size={16} /> Split view with the next tab
                <span className="kbd">Ctrl+\</span>
              </button>
            )}
            {tabMenu.id !== 'home' && (
              <>
                <div className="menu-sep" />
                <button className="menu-item" onClick={() => (requestCloseTab(tabMenu.id), closeTabMenu())}>
                  <X size={16} /> Close
                  <span className="kbd">Ctrl+W</span>
                </button>
                <button
                  className="menu-item"
                  onClick={async () => {
                    const keep = tabMenu.id;
                    closeTabMenu();
                    for (const t of useTabs.getState().tabs) if (t.id !== keep && t.id !== 'home') await requestCloseTab(t.id);
                  }}
                >
                  <XSquare size={16} /> Close other tabs
                </button>
              </>
            )}
          </Popover>
        </>
      )}
    </div>
  );
}

/** One button per area that has its own screen (School, Work), only for the areas that are on. */
function AreaButtons() {
  const areas = useAreas();
  const setupDone = useSetupDone();
  const tabs = useTabs((s) => s.tabs);
  const activeId = useTabs((s) => s.activeId);
  const activeKind = tabs.find((t) => t.id === activeId)?.kind;
  const items = [
    areas.includes('school') && { kind: 'scholar', label: 'School', icon: <GraduationCap size={16} />, open: () => openScholar() },
    areas.includes('work') && { kind: 'work', label: 'Work', icon: <Briefcase size={16} />, open: () => openWork() }
  ].filter(Boolean) as { kind: string; label: string; icon: JSX.Element; open: () => void }[];
  if (!setupDone || !items.length) return null;
  return (
    <div className="area-buttons">
      {items.map((it) => (
        <button key={it.kind} className={`icon-btn sm area-btn ${activeKind === it.kind ? 'on' : ''}`} title={it.label} aria-label={it.label} onClick={it.open}>
          {it.icon}
        </button>
      ))}
    </div>
  );
}
