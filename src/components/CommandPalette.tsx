import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { toggleVoice } from './VoiceTyping';
import { Search, FileText, Sheet, Presentation, FileCode2, FolderOpen, Settings, History, RefreshCw, Sparkles, Home, LayoutTemplate, FileSearch, Loader2, AppWindow, Columns2, Mic } from 'lucide-react';
import { useTabs } from '../store';
import { api, RecentEntry } from '../lib/api';
import { newFile, openWithDialog, openPaths } from '../lib/open';
import { openSettings, SECTIONS } from '../lib/settings';
import { openHistory } from './settings/VersionHistory';
import { openUpdates } from './Updates';
import { toggleAi } from './ai/aiStore';
import { TEMPLATES } from '../editors/doc/templates';
import { openTemplate } from './home/Templates';
import { FileIcon } from './FileIcon';
import { timeAgo } from '../lib/util';

export const usePalette = create<{ open: boolean; set(o: boolean): void }>((set) => ({ open: false, set: (open) => set({ open }) }));
export const openPalette = () => usePalette.getState().set(true);

interface Item {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  run(): void;
}

const match = (text: string, q: string) => q.split(/\s+/).every((w) => text.toLowerCase().includes(w));

/** Ctrl+Shift+P / Alt+/: run any command, switch tabs, open recent files, or search inside files. */
export function CommandPalette() {
  const open = usePalette((s) => s.open);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [recent, setRecent] = useState<RecentEntry[]>([]);
  const [hits, setHits] = useState<{ path: string; name: string; snippet: string }[] | null>(null);
  const [searching, setSearching] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const tabs = useTabs((s) => s.tabs);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setSel(0);
    setHits(null);
    api.getRecent().then(setRecent);
  }, [open]);

  // Search inside files once the query is long enough (after a short pause).
  useEffect(() => {
    if (!open || q.trim().length < 3) {
      setHits(null);
      return;
    }
    let alive = true;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await api.searchContent(q.trim());
        if (alive) setHits(r);
      } finally {
        if (alive) setSearching(false);
      }
    }, 450);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, open]);

  const items = useMemo<Item[]>(() => {
    const close = () => usePalette.getState().set(false);
    const act = (fn: () => void) => () => (close(), fn());
    const list: Item[] = [
      { id: 'new-doc', group: 'Create', label: 'New document', hint: 'Ctrl+N', icon: <FileText size={16} color="#8ab4f8" />, run: act(() => newFile('doc')) },
      { id: 'new-sheet', group: 'Create', label: 'New spreadsheet', icon: <Sheet size={16} color="#81c995" />, run: act(() => newFile('sheet')) },
      { id: 'new-slides', group: 'Create', label: 'New presentation', icon: <Presentation size={16} color="#fcad70" />, run: act(() => newFile('slides')) },
      { id: 'new-text', group: 'Create', label: 'New text file', icon: <FileCode2 size={16} color="#c58af9" />, run: act(() => newFile('code')) },
      ...TEMPLATES.map((t) => ({ id: 'tpl-' + t.id, group: 'Create', label: `New from template: ${t.name}`, hint: t.group, icon: <LayoutTemplate size={16} />, run: act(() => openTemplate(t)) })),
      { id: 'open', group: 'Files', label: 'Open a file…', hint: 'Ctrl+O', icon: <FolderOpen size={16} />, run: act(() => openWithDialog()) },
      { id: 'home', group: 'Files', label: 'Go to Home', icon: <Home size={16} />, run: act(() => useTabs.getState().setActive('home')) },
      { id: 'history', group: 'Files', label: 'Version history of this file', hint: 'Ctrl+Shift+H', icon: <History size={16} />, run: act(() => openHistory()) },
      { id: 'ai', group: 'Tools', label: 'Show or hide the AI sidebar', hint: 'Ctrl+J', icon: <Sparkles size={16} />, run: act(() => toggleAi()) },
      useTabs.getState().split
        ? { id: 'split-close', group: 'Tools', label: 'Close split view', hint: 'Ctrl+\\', icon: <Columns2 size={16} />, run: act(() => useTabs.getState().closeSplit()) }
        : { id: 'split', group: 'Tools', label: 'Split view: two tabs side by side', hint: 'Ctrl+\\', icon: <Columns2 size={16} />, run: act(() => useTabs.getState().openSplit()) },
      ...tabs
        .filter((t) => t.id !== useTabs.getState().activeId)
        .map((t) => ({ id: 'beside-' + t.id, group: 'Open tabs', label: `Open beside: ${t.name}`, hint: 'Split view', icon: <Columns2 size={16} />, run: act(() => (useTabs.getState().closeSplit(), useTabs.getState().openSplit(t.id))) })),
      { id: 'voice', group: 'Tools', label: 'Voice typing', hint: 'Ctrl+Alt+V', icon: <Mic size={16} />, run: act(() => toggleVoice()) },
      { id: 'updates', group: 'Tools', label: 'Check for updates', icon: <RefreshCw size={16} />, run: act(() => openUpdates()) },
      ...SECTIONS.map((s) => ({ id: 'set-' + s.id, group: 'Settings', label: `Settings: ${s.label}`, icon: <Settings size={16} />, run: act(() => openSettings(s.id)) })),
      ...SECTIONS.flatMap((s) => s.fields.map((f) => ({ id: 'opt-' + f.key, group: 'Settings', label: f.label, hint: s.label, icon: <Settings size={16} />, run: act(() => openSettings(s.id)) }))),
      ...tabs
        .filter((t) => t.kind !== 'home')
        .map((t) => ({ id: 'tab-' + t.id, group: 'Open tabs', label: t.name, hint: 'Switch to tab', icon: <AppWindow size={16} />, run: act(() => useTabs.getState().setActive(t.id)) })),
      ...recent.map((r) => ({ id: 'rec-' + r.path, group: 'Recent files', label: r.name, hint: timeAgo(r.openedAt), icon: <FileIcon name={r.name} size={16} />, run: act(() => openPaths([r.path])) }))
    ];
    const query = q.trim().toLowerCase();
    const shown = query ? list.filter((i) => match(`${i.label} ${i.group} ${i.hint || ''}`, query)) : list.filter((i) => !i.id.startsWith('opt-') && !i.id.startsWith('tpl-')).slice(0, 40);
    const content = (hits || []).map((h) => ({ id: 'in-' + h.path, group: 'Inside files', label: h.name, hint: h.snippet, icon: <FileSearch size={16} />, run: act(() => openPaths([h.path])) }));
    return [...shown.slice(0, 60), ...content];
  }, [q, tabs, recent, hits]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.cp-item.on')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;
  const close = () => usePalette.getState().set(false);
  let lastGroup = '';
  return (
    <div className="scrim cp-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="cp" role="dialog" aria-label="Command palette">
        <div className="cp-input">
          <Search size={18} />
          <input
            autoFocus
            placeholder="Type a command, a file name, or words inside a file…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setSel((s) => Math.min(items.length - 1, s + 1)));
              else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
              else if (e.key === 'Enter') (e.preventDefault(), items[sel]?.run());
              else if (e.key === 'Escape') (e.preventDefault(), e.stopPropagation(), close());
            }}
          />
          {searching && <Loader2 size={16} className="spin muted" />}
        </div>
        <div className="cp-list" ref={listRef}>
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? it.group : null;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {head && <div className="cp-group">{head}</div>}
                <button className={`cp-item ${i === sel ? 'on' : ''}`} onMouseMove={() => setSel(i)} onClick={() => it.run()}>
                  <span className="cp-icon">{it.icon}</span>
                  <span className="cp-label">{it.label}</span>
                  {it.hint && <span className="cp-hint">{it.hint}</span>}
                </button>
              </div>
            );
          })}
          {!items.length && !searching && <div className="cp-empty">Nothing found{q.trim().length >= 3 ? ', not even inside your files' : ''}.</div>}
        </div>
        <div className="cp-foot">
          <span>↑↓ to move · Enter to run · Esc to close</span>
          <span>Searches Desktop, Documents and Downloads for words inside files</span>
        </div>
      </div>
    </div>
  );
}
