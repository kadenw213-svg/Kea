import { useEffect, useMemo, useRef, useState } from 'react';
import { RotateCcw, RotateCw, FlipHorizontal2, FlipVertical2, ZoomIn, ZoomOut, Maximize, Save, MoreVertical, FileType2, Printer, Copy } from 'lucide-react';
import type { Tab } from '../../store';
import { editorRegistry, setDirty, toast, useTabs } from '../../store';
import { saveTabFile, exportFile, SaveFormat } from '../../lib/save';
import { extOf, baseName } from '../../lib/fileTypes';
import { mimeFor, imagesToPdf } from '../../lib/pdfTools';
import { formatBytes, blobToBytes, clamp } from '../../lib/util';
import { api } from '../../lib/api';
import { MenuButton } from '../../components/Popover';
import './image.css';

export default function ImageViewer({ tab, active }: { tab: Tab; active: boolean }) {
  const url = useMemo(() => (tab.data ? URL.createObjectURL(new Blob([tab.data as BlobPart], { type: mimeFor(tab.name) })) : ''), []);
  const [natural, setNatural] = useState({ w: 0, h: 0 });
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [rot, setRot] = useState(0);
  const [flip, setFlip] = useState({ h: false, v: false });
  const [fitScale, setFitScale] = useState(1);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const changed = rot !== 0 || flip.h || flip.v;

  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  useEffect(() => setDirty(tab.id, changed), [changed]);

  const swapped = rot % 180 !== 0;
  const dispW = swapped ? natural.h : natural.w;
  const dispH = swapped ? natural.w : natural.h;

  useEffect(() => {
    const el = stageRef.current;
    if (!el || !natural.w) return;
    const update = () => setFitScale(Math.min(1, (el.clientWidth - 48) / dispW, (el.clientHeight - 48) / dispH));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [natural, dispW, dispH]);

  const scale = zoom === 'fit' ? fitScale : zoom;

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom((z) => clamp((z === 'fit' ? fitScale : z) * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 0.05, 16));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [fitScale]);

  /** Render the image with the current rotation/flip applied. */
  const render = async (mime: string): Promise<Uint8Array> => {
    const img = imgRef.current!;
    const c = document.createElement('canvas');
    c.width = dispW;
    c.height = dispH;
    const ctx = c.getContext('2d')!;
    if (mime === 'image/jpeg') {
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, c.width, c.height);
    }
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.scale(flip.h ? -1 : 1, flip.v ? -1 : 1);
    ctx.drawImage(img, -natural.w / 2, -natural.h / 2);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), mime, 0.92));
    return blobToBytes(blob);
  };

  const ext = extOf(tab.name);
  const formats = (): SaveFormat[] => {
    const png: SaveFormat = { name: 'PNG image', ext: 'png', build: () => render('image/png') };
    const jpg: SaveFormat = { name: 'JPEG image', ext: 'jpg', build: () => render('image/jpeg') };
    const webp: SaveFormat = { name: 'WebP image', ext: 'webp', build: () => render('image/webp') };
    const all = [png, jpg, webp];
    const cur = ext === 'jpeg' ? { ...jpg, ext: 'jpeg' } : all.find((f) => f.ext === ext);
    return cur ? [cur, ...all.filter((f) => f.ext !== cur.ext)] : all;
  };
  const save = async (saveAs: boolean) => {
    if (!changed && !saveAs) return true;
    const ok = await saveTabFile(tab.id, formats(), saveAs);
    return ok;
  };
  const toPdf = async () => {
    const bytes = changed ? await render('image/png') : tab.data!;
    const pdf = await imagesToPdf([{ path: '', name: changed ? 'image.png' : tab.name, data: bytes }]);
    useTabs.getState().addTab({ kind: 'pdf', name: `${baseName(tab.name)}.pdf`, path: null, data: pdf });
  };
  const print = async () => {
    const bytes = await render('image/png');
    const b64 = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''));
    await api.printHtml(`<!doctype html><html><head><style>@page{margin:0.5in}body{margin:0;display:flex;justify-content:center}img{max-width:100%;max-height:100vh}</style></head><body><img src="data:image/png;base64,${b64}"></body></html>`);
  };
  const copyToClipboard = async () => {
    try {
      const bytes = await render('image/png');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes as BlobPart], { type: 'image/png' }) })]);
      toast('Image copied', 'success');
    } catch {
      toast("Couldn't copy the image", 'error');
    }
  };

  const handlers = useRef({ save, print });
  handlers.current = { save, print };
  useEffect(() => {
    editorRegistry.set(tab.id, { save: (a) => handlers.current.save(a), print: () => handlers.current.print() });
  }, [tab.id]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return;
      if (e.ctrlKey && (e.key === '=' || e.key === '+')) {
        e.preventDefault();
        setZoom((z) => clamp((z === 'fit' ? fitScale : z) * 1.25, 0.05, 16));
      } else if (e.ctrlKey && e.key === '-') {
        e.preventDefault();
        setZoom((z) => clamp((z === 'fit' ? fitScale : z) / 1.25, 0.05, 16));
      } else if (e.ctrlKey && e.key === '0') {
        e.preventDefault();
        setZoom('fit');
      } else if (!e.ctrlKey && e.key.toLowerCase() === 'r') setRot((r) => (r + (e.shiftKey ? 270 : 90)) % 360);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="image-viewer">
      <div className="toolbar">
        <button className="icon-btn" title="Rotate left (Shift+R)" onClick={() => setRot((r) => (r + 270) % 360)}>
          <RotateCcw size={18} />
        </button>
        <button className="icon-btn" title="Rotate right (R)" onClick={() => setRot((r) => (r + 90) % 360)}>
          <RotateCw size={18} />
        </button>
        <button className={`icon-btn ${flip.h ? 'active' : ''}`} title="Flip horizontally" onClick={() => setFlip((f) => ({ ...f, h: !f.h }))}>
          <FlipHorizontal2 size={18} />
        </button>
        <button className={`icon-btn ${flip.v ? 'active' : ''}`} title="Flip vertically" onClick={() => setFlip((f) => ({ ...f, v: !f.v }))}>
          <FlipVertical2 size={18} />
        </button>
        <div className="tb-sep" />
        <button className="icon-btn" title="Zoom out" onClick={() => setZoom(clamp(scale / 1.25, 0.05, 16))}>
          <ZoomOut size={18} />
        </button>
        <button className="zoom-label" onClick={() => setZoom(zoom === 'fit' ? 1 : 'fit')} title="Toggle fit / 100%">
          {Math.round(scale * 100)}%
        </button>
        <button className="icon-btn" title="Zoom in" onClick={() => setZoom(clamp(scale * 1.25, 0.05, 16))}>
          <ZoomIn size={18} />
        </button>
        <button className={`icon-btn ${zoom === 'fit' ? 'active' : ''}`} title="Fit to window (Ctrl+0)" onClick={() => setZoom('fit')}>
          <Maximize size={18} />
        </button>
        <div className="tb-spacer" />
        <button className="btn tonal sm" onClick={toPdf} title="Open as a PDF to annotate or combine">
          <FileType2 size={16} /> Make PDF
        </button>
        <button className="btn primary sm" onClick={() => save(false)} disabled={!changed} title="Save (Ctrl+S)">
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
                <Save size={16} /> Save as / convert… <span className="kbd">Ctrl+Shift+S</span>
              </button>
              <button className="menu-item" onClick={() => (copyToClipboard(), close())}>
                <Copy size={16} /> Copy image
              </button>
              <button className="menu-item" onClick={() => (print(), close())}>
                <Printer size={16} /> Print… <span className="kbd">Ctrl+P</span>
              </button>
            </>
          )}
        </MenuButton>
      </div>
      <div className="image-stage" ref={stageRef}>
        {url && (
          <div className="image-frame" style={{ width: dispW * scale, height: dispH * scale }}>
            <img
              ref={imgRef}
              src={url}
              alt={tab.name}
              draggable={false}
              onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth || 800, h: e.currentTarget.naturalHeight || 600 })}
              style={{
                width: natural.w * scale,
                height: natural.h * scale,
                transform: `translate(-50%, -50%) rotate(${rot}deg) scale(${flip.h ? -1 : 1}, ${flip.v ? -1 : 1})`
              }}
            />
          </div>
        )}
      </div>
      <div className="statusbar">
        <span>
          {natural.w} × {natural.h} px
        </span>
        <span>{tab.data ? formatBytes(tab.data.length) : ''}</span>
        <span>{ext.toUpperCase()}</span>
        <span className="grow" />
        {changed && <span style={{ color: 'var(--accent)' }}>Edited · save to keep changes</span>}
      </div>
    </div>
  );
}

export { exportFile };
