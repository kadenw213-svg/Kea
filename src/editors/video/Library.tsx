import { useMemo, useState, MutableRefObject } from 'react';
import { Upload, Film, Music, Image as ImageIcon, Search, Trash2, FolderOpen, ListPlus, Eye, FileWarning, Type, Square, Circle, RectangleHorizontal, Blend } from 'lucide-react';
import { api } from '../../lib/api';
import { ask, toast } from '../../store';
import type { MediaItem, TextStyle } from './model';
import { shortTime, TRANSITIONS, DEFAULT_TEXT } from './model';
import { useVE, useVEStore } from './state';
import { mediaKey, useMediaCache, forgetInput, warmMedia, probe } from './media';
import { seedBlob } from './host';
import { DND_MEDIA, DND_TEXT, DND_TRANSITION, ContextMenu } from './Timeline';
import { SourceViewer, SourceControls } from './SourceViewer';
import * as act from './actions';

/* Left-hand panel: media bin, source viewer, text and graphics, transitions. */

export type LibraryTab = 'media' | 'source' | 'text' | 'transitions';

export function Library({
  tab,
  setTab,
  onImport,
  onDropFiles,
  sourceControls,
  onRelinked
}: {
  tab: LibraryTab;
  setTab(t: LibraryTab): void;
  onImport(): void;
  onDropFiles(files: File[]): void;
  sourceControls: MutableRefObject<SourceControls | null>;
  onRelinked(): void;
}) {
  const tabs: { id: LibraryTab; label: string }[] = [
    { id: 'media', label: 'Media' },
    { id: 'source', label: 'Source' },
    { id: 'text', label: 'Text' },
    { id: 'transitions', label: 'Transitions' }
  ];
  return (
    <div className="ve-library">
      <div className="ve-tabs">
        {tabs.map((t) => (
          <button key={t.id} className={`ve-tab ${tab === t.id ? 'on' : ''}`} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="ve-library-body">
        {tab === 'media' && <MediaBin onImport={onImport} onDropFiles={onDropFiles} openSource={() => setTab('source')} onRelinked={onRelinked} />}
        {tab === 'source' && <SourceViewer controls={sourceControls} />}
        {tab === 'text' && <TextPanel />}
        {tab === 'transitions' && <TransitionsPanel />}
      </div>
    </div>
  );
}

function MediaBin({ onImport, onDropFiles, openSource, onRelinked }: { onImport(): void; onDropFiles(files: File[]): void; openSource(): void; onRelinked(): void }) {
  const store = useVEStore();
  const media = useVE((s) => s.project.media);
  const clips = useVE((s) => s.project.clips);
  const thumbs = useMediaCache((s) => s.thumbs);
  const missing = useMediaCache((s) => s.missing);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [over, setOver] = useState(false);
  const [menu, setMenu] = useState<{ at: { x: number; y: number }; m: MediaItem } | null>(null);
  const uses = useMemo(() => {
    const n: Record<string, number> = {};
    for (const c of clips) if (c.mediaId) n[c.mediaId] = (n[c.mediaId] || 0) + 1;
    return n;
  }, [clips]);
  const list = media.filter((m) => m.name.toLowerCase().includes(q.toLowerCase()));

  const openInSource = (m: MediaItem) => {
    store.setState({ source: { mediaId: m.id, in: null, out: null, t: 0 }, focus: 'source' });
    openSource();
  };

  const relink = async (m: MediaItem) => {
    const files = await api.openDialog({ title: `Find ${m.name}`, filters: [{ name: 'Media', extensions: [m.name.split('.').pop() || '*', '*'] }] });
    const f = files[0];
    if (!f) return;
    seedBlob(f.path, f.data, f.name);
    try {
      const info = await probe(f.path, f.name);
      if (info.kind !== m.kind) return toast(`${f.name} is ${info.kind === 'image' ? 'an image' : `a ${info.kind} file`}, not ${m.kind === 'image' ? 'an image' : `a ${m.kind} file`}`, 'error');
      forgetInput(mediaKey(m));
      store.getState().commit('Relink media', (p) => {
        const x = p.media.find((y) => y.id === m.id)!;
        Object.assign(x, { path: f.path, name: f.name, duration: info.duration, width: info.width, height: info.height, fps: info.fps, hasAudio: info.hasAudio, hasVideo: info.hasVideo });
      });
      useMediaCache.getState().set({ missing: { [mediaKey(m)]: false, [f.path]: false } });
      warmMedia({ ...m, path: f.path });
      onRelinked();
      toast(`Relinked ${m.name}`, 'success');
    } catch (err: any) {
      toast(err?.message || String(err), 'error');
    }
  };

  const remove = async (m: MediaItem) => {
    const n = uses[m.id] || 0;
    if (n) {
      const b = await ask('Remove from project?', `${m.name} is used by ${n} clip${n > 1 ? 's' : ''} on the timeline. Removing it also removes those clips.`, [
        { id: 'cancel', label: 'Cancel' },
        { id: 'ok', label: 'Remove', primary: true, danger: true }
      ]);
      if (b !== 'ok') return;
    }
    store.getState().commit('Remove media', (p) => {
      p.media = p.media.filter((x) => x.id !== m.id);
      p.clips = p.clips.filter((c) => c.mediaId !== m.id);
    });
  };

  return (
    <div
      className={`ve-bin ${over ? 'drop' : ''}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        if (e.dataTransfer.files.length) onDropFiles([...e.dataTransfer.files]);
      }}
    >
      <div className="ve-bin-head">
        <div className="ve-search">
          <Search size={14} />
          <input placeholder="Search media" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </div>
        <button className="btn tonal sm" onClick={onImport} title="Import video, audio or pictures">
          <Upload size={15} /> Import
        </button>
      </div>
      {!media.length ? (
        <div className="ve-bin-empty" onClick={onImport}>
          <Upload size={28} />
          <div>Drop video, audio or pictures here</div>
          <div className="dim">or click to choose files</div>
        </div>
      ) : (
        <div className="ve-bin-grid">
          {list.map((m) => {
            const key = mediaKey(m);
            const off = !!missing[key];
            return (
              <div
                key={m.id}
                className={`ve-bin-item ${picked === m.id ? 'on' : ''} ${off ? 'offline' : ''}`}
                draggable={!off}
                onDragStart={(e) => {
                  e.dataTransfer.setData(DND_MEDIA, m.id);
                  e.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => setPicked(m.id)}
                onDoubleClick={() => (off ? relink(m) : openInSource(m))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setPicked(m.id);
                  setMenu({ at: { x: e.clientX, y: e.clientY }, m });
                }}
                title={`${m.name}\n${m.path || 'Not saved on disk'}${off ? '\nMissing: double-click to find it' : '\nDouble-click to preview · drag to the timeline'}`}
              >
                <div className="ve-bin-thumb">
                  {thumbs[key] ? <img src={thumbs[key]} alt="" draggable={false} /> : m.kind === 'audio' ? <Music size={26} /> : m.kind === 'image' ? <ImageIcon size={26} /> : <Film size={26} />}
                  {off && (
                    <span className="ve-bin-missing">
                      <FileWarning size={14} /> Missing
                    </span>
                  )}
                  {m.kind !== 'image' && <span className="ve-bin-dur">{shortTime(m.duration).replace(/\.\d+$/, '')}</span>}
                  {uses[m.id] ? <span className="ve-bin-used" title={`Used ${uses[m.id]} time${uses[m.id] > 1 ? 's' : ''}`} /> : null}
                </div>
                <div className="ve-bin-name">{m.name}</div>
                <div className="ve-bin-meta">
                  {m.kind === 'audio' ? 'Audio' : `${m.width}×${m.height}`}
                  {m.kind === 'video' ? ` · ${Math.round(m.fps * 100) / 100} fps` : ''}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {menu && (
        <ContextMenu
          at={menu.at}
          onClose={() => setMenu(null)}
          items={[
            { label: 'Preview in source viewer', icon: <Eye size={16} />, run: () => openInSource(menu.m) },
            { label: 'Add at playhead', icon: <ListPlus size={16} />, run: () => act.placeMedia(store, menu.m, store.getState().playhead) },
            { label: 'Add to the end', icon: <ListPlus size={16} />, run: () => act.appendMedia(store, [menu.m]) },
            { sep: true },
            { label: 'Find missing file…', icon: <FileWarning size={16} />, run: () => relink(menu.m) },
            { label: 'Show in folder', icon: <FolderOpen size={16} />, disabled: !menu.m.path, run: () => api.showInFolder(menu.m.path) },
            { sep: true },
            { label: 'Remove from project', icon: <Trash2 size={16} />, run: () => remove(menu.m) }
          ]}
        />
      )}
    </div>
  );
}

function TextPanel() {
  const store = useVEStore();
  const H = useVE((s) => s.project.settings.height);
  const W = useVE((s) => s.project.settings.width);
  const k = Math.min(W, H) / 1080;
  const presets: { name: string; style: Partial<TextStyle>; y: number; preview: React.CSSProperties }[] = [
    { name: 'Title', style: { text: 'Title', size: Math.round(130 * k), bold: true, animIn: 'fade', animOut: 'fade' }, y: 0, preview: { fontWeight: 700, fontSize: 20 } },
    {
      name: 'Lower third',
      style: { text: 'Name Surname\nRole', size: Math.round(52 * k), align: 'left', box: '#000000', boxOpacity: 65, boxPadding: Math.round(22 * k), shadowBlur: 0, shadowY: 0, animIn: 'slideLeft', animOut: 'fade' },
      y: Math.round(H * 0.3),
      preview: { fontSize: 12, background: 'rgba(0,0,0,.65)', padding: '2px 6px', textAlign: 'left' }
    },
    {
      name: 'Caption',
      style: { text: 'Caption text', size: Math.round(58 * k), bold: true, outline: '#000000', outlineWidth: Math.max(2, Math.round(5 * k)), shadowBlur: 0, shadowY: 0, animIn: 'none', animOut: 'none' },
      y: Math.round(H * 0.36),
      preview: { fontSize: 14, fontWeight: 700, WebkitTextStroke: '1px #000' }
    },
    { name: 'Big and bold', style: { text: 'BIG NEWS', font: 'Impact', size: Math.round(200 * k), bold: false, outline: '#000000', outlineWidth: Math.round(8 * k), animIn: 'pop', animOut: 'fade' }, y: 0, preview: { fontFamily: 'Impact', fontSize: 22 } },
    { name: 'Typewriter', style: { text: 'Typing as we go…', font: 'Courier New', size: Math.round(72 * k), bold: false, animIn: 'typewriter', animOut: 'fade' }, y: 0, preview: { fontFamily: 'Courier New', fontSize: 14 } },
    { name: 'Glow', style: { text: 'Glow', size: Math.round(140 * k), color: '#e0fbff', shadow: '#22d3ee', shadowBlur: Math.round(40 * k), shadowY: 0, animIn: 'fade', animOut: 'fade' }, y: 0, preview: { fontSize: 20, color: '#e0fbff', textShadow: '0 0 8px #22d3ee' } },
    { name: 'Rising subtitle', style: { text: 'A line that rises in', size: Math.round(64 * k), bold: false, animIn: 'slideUp', animOut: 'slideUp' }, y: Math.round(H * 0.25), preview: { fontSize: 13 } },
    { name: 'Label box', style: { text: 'LABEL', size: Math.round(48 * k), color: '#062e6f', box: '#a8c7fa', boxOpacity: 100, boxRadius: Math.round(40 * k), boxPadding: Math.round(20 * k), shadowBlur: 0, shadowY: 0, animIn: 'pop', animOut: 'fade' }, y: 0, preview: { fontSize: 12, color: '#062e6f', background: '#a8c7fa', borderRadius: 10, padding: '1px 8px', fontWeight: 700 } }
  ];
  return (
    <div className="ve-presets">
      <div className="ve-section-title">Text</div>
      <div className="ve-preset-grid">
        {presets.map((p) => (
          <button
            key={p.name}
            className="ve-preset"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DND_TEXT, JSON.stringify({ ...DEFAULT_TEXT, ...p.style, y: p.y }));
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => act.addText(store, p.style, undefined, 3, p.y)}
            title="Click to add at the playhead, or drag onto the timeline"
          >
            <span className="ve-preset-look" style={p.preview}>
              {p.style.text?.split('\n')[0]}
            </span>
            <span className="ve-preset-name">{p.name}</span>
          </button>
        ))}
      </div>
      <div className="ve-section-title">Graphics</div>
      <div className="ve-preset-list">
        <button className="ve-row-btn" onClick={() => act.addShape(store, { shape: 'matte', fill: '#000000' })} title="A full-frame block of colour">
          <RectangleHorizontal size={16} /> Colour matte
        </button>
        <button className="ve-row-btn" onClick={() => act.addShape(store, { shape: 'rect', w: Math.round(W * 0.4), h: Math.round(H * 0.25), radius: Math.round(16 * k) })}>
          <Square size={16} /> Rectangle
        </button>
        <button className="ve-row-btn" onClick={() => act.addShape(store, { shape: 'ellipse', w: Math.round(H * 0.4), h: Math.round(H * 0.4) })}>
          <Circle size={16} /> Circle
        </button>
        <button className="ve-row-btn" onClick={() => act.addText(store, { text: 'Your text' })}>
          <Type size={16} /> Plain text
        </button>
      </div>
    </div>
  );
}

function TransitionsPanel() {
  const store = useVEStore();
  const apply = (type: (typeof TRANSITIONS)[number]['id']) => {
    const s = store.getState();
    const c = s.project.clips.find((x) => x.id === s.sel[0]);
    if (!c) return toast('Select a clip first, or drag the transition onto a cut');
    const mid = c.start + (c.out - c.in) / c.speed / 2;
    act.addTransitionAt(store, c.id, s.playhead < mid ? 'in' : 'out', type);
  };
  return (
    <div className="ve-presets">
      <p className="ve-hint">Drag a transition onto the start or end of a clip. On a cut it blends the two clips; on a free edge it fades from or to nothing. On sound clips any transition is a crossfade.</p>
      <div className="ve-preset-list">
        {TRANSITIONS.map((t) => (
          <button
            key={t.id}
            className="ve-row-btn tall"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DND_TRANSITION, t.id);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => apply(t.id)}
            title="Click to add to the selected clip (nearest end to the playhead)"
          >
            <span className={`ve-tr-swatch ${t.id}`}>
              <Blend size={14} />
            </span>
            <span>
              <b>{t.label}</b>
              <span className="dim">{t.hint}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
