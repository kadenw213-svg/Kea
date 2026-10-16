import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { X, History, RotateCcw, Eye, Tag, Trash2, Plus } from 'lucide-react';
import { api, VersionInfo } from '../../lib/api';
import { useTabs, toast, ask, prompt } from '../../store';
import { formatBytes } from '../../lib/util';
import { baseName, extOf } from '../../lib/fileTypes';
import { autosaveNow } from '../../lib/autosave';
import { openSettings, useSetting } from '../../lib/settings';

export const useHistoryUi = create<{ open: boolean; set(o: boolean): void }>((set) => ({ open: false, set: (open) => set({ open }) }));
export const openHistory = () => useHistoryUi.getState().set(true);

const fmt = (ts: number) => {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const yesterday = new Date(today.getTime() - 864e5).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today, ${time}`;
  if (yesterday) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })}, ${time}`;
};

export function VersionHistoryDialog() {
  const open = useHistoryUi((s) => s.open);
  const tab = useTabs((s) => s.tabs.find((t) => t.id === s.activeId));
  const enabled = useSetting<boolean>('files.versions');
  const [list, setList] = useState<VersionInfo[] | null>(null);

  const refresh = () => tab?.path && api.history.list(tab.path).then(setList);
  useEffect(() => {
    setList(null);
    if (open) refresh();
  }, [open, tab?.path]);

  if (!open) return null;
  const close = () => useHistoryUi.getState().set(false);

  const preview = async (v: VersionInfo) => {
    const data = await api.history.read(tab!.path!, v.id);
    const name = `${baseName(tab!.name)} (${fmt(v.ts).replace(/[,:]/g, '.')}).${extOf(tab!.name)}`;
    useTabs.getState().addTab({ kind: tab!.kind as any, name, path: null, data });
    close();
  };

  const restore = async (v: VersionInfo) => {
    const t = tab!;
    const choice = await ask(
      'Restore this version?',
      `${t.name} will go back to how it was on ${fmt(v.ts)}. The current version is kept in history, so you can undo this.`,
      [
        { id: 'cancel', label: 'Cancel' },
        { id: 'ok', label: 'Restore', primary: true }
      ]
    );
    if (choice !== 'ok') return;
    if (t.dirty) await autosaveNow(t.id);
    await api.history.snapshot(t.path!, 'Before restoring');
    const data = await api.history.read(t.path!, v.id);
    await api.writeFile(t.path!, data);
    const cur = useTabs.getState().tabs.find((x) => x.id === t.id)!;
    useTabs.getState().updateTab(t.id, { data, dirty: false, version: cur.version + 1 });
    toast('Version restored', 'success');
    close();
  };

  const body = () => {
    if (!tab || tab.kind === 'home') return <p>Open a file to see its earlier versions.</p>;
    if (!tab.path) return <p>Save this file first. Kea keeps its versions from then on.</p>;
    if (!list) return <div className="muted">Loading…</div>;
    return (
      <>
        {!enabled && (
          <p>
            Version history is turned off, so no new versions are being kept.{' '}
            <button className="link-btn" onClick={() => (close(), openSettings('files'))}>
              Turn it on
            </button>
          </p>
        )}
        <div className="history-list">
          <div className="hrow current">
            <History size={18} />
            <div className="hrow-main">
              <div className="hrow-when">Current version</div>
              <div className="hrow-sub">{tab.dirty ? 'Has unsaved changes' : 'Saved'}</div>
            </div>
          </div>
          {list.length === 0 && <div className="muted" style={{ padding: 12 }}>No earlier versions yet. They appear as you save changes.</div>}
          {list.map((v) => (
            <div key={v.id} className="hrow">
              <div className="hrow-main">
                <div className="hrow-when">{fmt(v.ts)}</div>
                {v.label && <div className="hrow-label">{v.label}</div>}
                <div className="hrow-sub">{formatBytes(v.size)}</div>
              </div>
              <button className="icon-btn sm" title="Open a copy" onClick={() => preview(v)}>
                <Eye size={15} />
              </button>
              <button
                className="icon-btn sm"
                title={v.label ? 'Rename' : 'Name this version'}
                onClick={async () => {
                  const label = await prompt('Name this version', 'Named versions are kept until you delete them.', v.label || '', 'e.g. Submitted draft');
                  if (label !== null) setList(await api.history.label(tab.path!, v.id, label.trim()));
                }}
              >
                <Tag size={15} />
              </button>
              <button
                className="icon-btn sm"
                title="Delete this version"
                onClick={async () => setList(await api.history.remove(tab.path!, v.id))}
              >
                <Trash2 size={15} />
              </button>
              <button className="btn sm tonal" onClick={() => restore(v)}>
                <RotateCcw size={13} /> Restore
              </button>
            </div>
          ))}
        </div>
      </>
    );
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="dialog history-dialog">
        <div className="ai-settings-head">
          <h2>Version history{tab?.path ? ` · ${tab.name}` : ''}</h2>
          <button className="icon-btn sm" onClick={close}>
            <X size={16} />
          </button>
        </div>
        {body()}
        <div className="dialog-actions">
          {tab?.path && (
            <button
              className="btn"
              onClick={async () => {
                const label = await prompt('Save a version now', 'Give it a name so it is easy to find (and kept until you delete it).', '', 'e.g. Before peer review');
                if (label === null) return;
                if (tab.dirty) await autosaveNow(tab.id);
                await api.history.snapshot(tab.path!, label.trim() || undefined);
                refresh();
              }}
            >
              <Plus size={14} /> Save a version now
            </button>
          )}
          <button className="btn primary" onClick={close}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
