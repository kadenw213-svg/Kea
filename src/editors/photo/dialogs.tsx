import { useEffect, useMemo, useRef, useState } from 'react';
import { Link2, Unlink2 } from 'lucide-react';
import type { Engine } from './engine';
import type { AdjType, FilterType, Adjustment, Filter, LayerBlend } from './types';
import { BLEND_MODES, isPixelLayer } from './types';
import { adjDefaults, ADJ_LABELS, histogram } from './adjustments';
import { filterDefaults, FILTER_LABELS } from './filters';
import { Modal, Slider, Check, Field, Seg, ColorInput, NumberField, AdjustmentControls, FilterControls } from './controls';
import * as ops from './ops';
import { Superseded } from './pixelJobs';
import { getPixels, canvasToBytes, makeCanvas, filledCanvas, hexToRgb } from './canvas';
import { encode } from './io';
import * as S from './selection';
import { selectionArea } from './selection';
import type { SelMode } from './selection';
import { toast, useTabs } from '../../store';
import { exportFile } from '../../lib/save';
import { baseName } from '../../lib/fileTypes';

/** The photo editor's dialogs. Each takes the engine and a `close` callback. */

export type DialogSpec =
  | { kind: 'adjust'; type: AdjType }
  | { kind: 'filter'; type: FilterType }
  | { kind: 'new' }
  | { kind: 'imageSize' }
  | { kind: 'canvasSize' }
  | { kind: 'rotate' }
  | { kind: 'modify'; op: 'feather' | 'expand' | 'contract' | 'border' }
  | { kind: 'fill' }
  | { kind: 'stroke' }
  | { kind: 'colorRange' }
  | { kind: 'fade' }
  | { kind: 'export'; tabName: string };

const run = async (fn: () => unknown, close?: () => void) => {
  try {
    await fn();
    close?.();
  } catch (err: any) {
    if (err instanceof Superseded) return;
    toast(err?.message || String(err), 'error');
  }
};

export function PhotoDialog({ spec, engine, close }: { spec: DialogSpec; engine: Engine; close(): void }) {
  switch (spec.kind) {
    case 'adjust':
      return <AdjustDialog e={engine} type={spec.type} close={close} />;
    case 'filter':
      return <FilterDialog e={engine} type={spec.type} close={close} />;
    case 'new':
      return <NewImageDialog e={engine} close={close} />;
    case 'imageSize':
      return <ImageSizeDialog e={engine} close={close} />;
    case 'canvasSize':
      return <CanvasSizeDialog e={engine} close={close} />;
    case 'rotate':
      return <RotateDialog e={engine} close={close} />;
    case 'modify':
      return <ModifyDialog e={engine} op={spec.op} close={close} />;
    case 'fill':
      return <FillDialog e={engine} close={close} />;
    case 'stroke':
      return <StrokeDialog e={engine} close={close} />;
    case 'colorRange':
      return <ColorRangeDialog e={engine} close={close} />;
    case 'fade':
      return <FadeDialog e={engine} close={close} />;
    case 'export':
      return <ExportDialog e={engine} tabName={spec.tabName} close={close} />;
  }
}

const Actions = ({ onCancel, onOk, ok = 'OK', busy }: { onCancel(): void; onOk(): void; ok?: string; busy?: boolean }) => (
  <>
    <button className="btn" onClick={onCancel}>
      Cancel
    </button>
    <button className="btn primary" onClick={onOk} disabled={busy}>
      {ok}
    </button>
  </>
);

/** Debounced live preview of a filter or adjustment on the active layer. */
function usePreview(e: Engine, op: 'filter' | 'adjust', params: Filter | Adjustment, on: boolean) {
  const [working, setWorking] = useState(false);
  useEffect(() => {
    if (!on) {
      e.preview = null;
      e.invalidate();
      return;
    }
    const t = setTimeout(() => {
      setWorking(true);
      ops
        .previewPixels(e, op, params)
        .then(() => setWorking(false))
        .catch((err) => {
          if (!(err instanceof Superseded)) {
            setWorking(false);
            toast(err?.message || String(err), 'error');
          }
        });
    }, 90);
    return () => clearTimeout(t);
  }, [JSON.stringify(params), on]);
  useEffect(
    () => () => {
      e.preview = null;
      e.invalidate();
    },
    []
  );
  return working;
}

function AdjustDialog({ e, type, close }: { e: Engine; type: AdjType; close(): void }) {
  const [adj, setAdj] = useState<Adjustment>(() => adjDefaults(type));
  const [preview, setPreview] = useState(true);
  const working = usePreview(e, 'adjust', adj, preview);
  const hist = useMemo(() => {
    const l = e.active;
    const src = isPixelLayer(l) ? l.canvas : e.flush();
    return histogram(getPixels(src).data, Math.max(1, Math.floor((src.width * src.height) / 400000)));
  }, []);
  return (
    <Modal
      title={ADJ_LABELS[type]}
      onClose={close}
      actions={
        <>
          <Check label="Preview" checked={preview} onChange={setPreview} />
          {working && <span className="ph-working">Updating preview…</span>}
          <span className="tb-spacer" />
          <Actions onCancel={close} onOk={() => run(() => ops.applyAdjustmentPixels(e, adj), close)} />
        </>
      }
    >
      <AdjustmentControls adj={adj} onChange={setAdj} hist={hist} />
    </Modal>
  );
}

function FilterDialog({ e, type, close }: { e: Engine; type: FilterType; close(): void }) {
  const [f, setF] = useState<Filter>(() => ({ ...filterDefaults(type), ...(lastFilterSettings[type] || {}) }));
  const [preview, setPreview] = useState(true);
  const working = usePreview(e, 'filter', f, preview);
  return (
    <Modal
      title={FILTER_LABELS[type]}
      onClose={close}
      actions={
        <>
          <Check label="Preview" checked={preview} onChange={setPreview} />
          {working && <span className="ph-working">Updating preview…</span>}
          <span className="tb-spacer" />
          <Actions
            onCancel={close}
            onOk={() =>
              run(() => {
                lastFilterSettings[type] = f;
                lastFilterRun = f;
                return ops.applyFilter(e, f);
              }, close)
            }
          />
        </>
      }
    >
      <FilterControls f={f} onChange={setF} />
      {e.selection && <p className="ph-hint">Only the selection ({selectionArea(e.selection)}) is changed.</p>}
    </Modal>
  );
}
/** Filters remember their last settings for the session (like Photoshop). */
const lastFilterSettings: Partial<Record<FilterType, Filter>> = {};
/** The last filter applied from a dialog (Filter → Again). */
export let lastFilterRun: Filter | null = null;

const SIZE_PRESETS = [
  { label: 'HD 1920 × 1080', w: 1920, h: 1080 },
  { label: '1280 × 720', w: 1280, h: 720 },
  { label: 'Square 1080 × 1080', w: 1080, h: 1080 },
  { label: '4K 3840 × 2160', w: 3840, h: 2160 },
  { label: 'A4 at 300 ppi (2480 × 3508)', w: 2480, h: 3508 },
  { label: 'Letter at 300 ppi (2550 × 3300)', w: 2550, h: 3300 },
  { label: '800 × 600', w: 800, h: 600 }
];

function NewImageDialog({ e, close }: { e: Engine; close(): void }) {
  const [w, setW] = useState(1920);
  const [h, setH] = useState(1080);
  const [bg, setBg] = useState<'white' | 'black' | 'transparent' | 'background'>('white');
  const create = async () => {
    if (!(w >= 1 && h >= 1 && w <= 30000 && h <= 30000)) throw new Error('Width and height must be between 1 and 30000 pixels');
    const c = bg === 'transparent' ? makeCanvas(w, h) : filledCanvas(w, h, bg === 'white' ? '#ffffff' : bg === 'black' ? '#000000' : e.bg);
    const data = await canvasToBytes(c, 'image/png');
    useTabs.getState().addTab({ kind: 'image', name: 'Untitled.png', path: null, data });
  };
  return (
    <Modal title="New image" onClose={close} actions={<Actions onCancel={close} onOk={() => run(create, close)} ok="Create" />}>
      <Field label="Preset">
        <select
          className="select ph-select"
          value=""
          onChange={(ev) => {
            const p = SIZE_PRESETS[parseInt(ev.target.value)];
            if (p) {
              setW(p.w);
              setH(p.h);
            }
          }}
        >
          <option value="">Choose a size…</option>
          {SIZE_PRESETS.map((p, i) => (
            <option key={i} value={i}>
              {p.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="ph-row">
        <Field label="Width (px)">
          <NumberField value={w} onChange={(v) => setW(Math.round(v))} min={1} max={30000} />
        </Field>
        <Field label="Height (px)">
          <NumberField value={h} onChange={(v) => setH(Math.round(v))} min={1} max={30000} />
        </Field>
      </div>
      <Field label="Background">
        <Seg
          value={bg}
          options={[
            { id: 'white', label: 'White' },
            { id: 'black', label: 'Black' },
            { id: 'background', label: 'Background colour' },
            { id: 'transparent', label: 'Transparent' }
          ]}
          onChange={setBg}
        />
      </Field>
    </Modal>
  );
}

function ImageSizeDialog({ e, close }: { e: Engine; close(): void }) {
  const [w, setW] = useState(e.doc.w);
  const [h, setH] = useState(e.doc.h);
  const [link, setLink] = useState(true);
  const [method, setMethod] = useState<'smooth' | 'nearest'>('smooth');
  const ratio = e.doc.w / e.doc.h;
  return (
    <Modal title="Image size" onClose={close} actions={<Actions onCancel={close} onOk={() => run(() => ops.resizeImage(e, w, h, method), close)} />}>
      <p className="ph-hint">
        Now {e.doc.w} × {e.doc.h} px. Resizing resamples every layer.
      </p>
      <div className="ph-row">
        <Field label="Width (px)">
          <NumberField
            value={w}
            min={1}
            max={30000}
            onChange={(v) => {
              setW(Math.round(v));
              if (link) setH(Math.max(1, Math.round(v / ratio)));
            }}
          />
        </Field>
        <button className={`icon-btn sm ${link ? 'active' : ''}`} title="Keep proportions" onClick={() => setLink(!link)}>
          {link ? <Link2 size={16} /> : <Unlink2 size={16} />}
        </button>
        <Field label="Height (px)">
          <NumberField
            value={h}
            min={1}
            max={30000}
            onChange={(v) => {
              setH(Math.round(v));
              if (link) setW(Math.max(1, Math.round(v * ratio)));
            }}
          />
        </Field>
        <Field label="Percent">
          <NumberField
            value={Math.round((w / e.doc.w) * 1000) / 10}
            min={1}
            max={1000}
            onChange={(p) => {
              setW(Math.max(1, Math.round((e.doc.w * p) / 100)));
              setH(Math.max(1, Math.round((e.doc.h * p) / 100)));
            }}
          />
        </Field>
      </div>
      <Field label="Resample">
        <Seg
          value={method}
          options={[
            { id: 'smooth', label: 'Smooth (photos)' },
            { id: 'nearest', label: 'Nearest neighbour (pixel art)' }
          ]}
          onChange={setMethod}
        />
      </Field>
    </Modal>
  );
}

function CanvasSizeDialog({ e, close }: { e: Engine; close(): void }) {
  const [w, setW] = useState(e.doc.w);
  const [h, setH] = useState(e.doc.h);
  const [anchor, setAnchor] = useState<ops.Anchor>({ ax: 0.5, ay: 0.5 });
  const [fill, setFill] = useState<'transparent' | 'white' | 'black' | 'background'>('transparent');
  const color = fill === 'transparent' ? null : fill === 'white' ? '#ffffff' : fill === 'black' ? '#000000' : e.bg;
  return (
    <Modal title="Canvas size" onClose={close} actions={<Actions onCancel={close} onOk={() => run(() => ops.canvasSize(e, w, h, anchor, color), close)} />}>
      <p className="ph-hint">
        Now {e.doc.w} × {e.doc.h} px. Adds or cuts space around the picture without resizing it.
      </p>
      <div className="ph-row">
        <Field label="Width (px)">
          <NumberField value={w} min={1} max={30000} onChange={(v) => setW(Math.round(v))} />
        </Field>
        <Field label="Height (px)">
          <NumberField value={h} min={1} max={30000} onChange={(v) => setH(Math.round(v))} />
        </Field>
      </div>
      <div className="ph-row" style={{ alignItems: 'flex-start' }}>
        <Field label="Anchor">
          <div className="ph-anchor">
            {[0, 0.5, 1].flatMap((ay) =>
              [0, 0.5, 1].map((ax) => (
                <button key={`${ax}-${ay}`} className={anchor.ax === ax && anchor.ay === ay ? 'on' : ''} onClick={() => setAnchor({ ax: ax as 0, ay: ay as 0 })} title="Keep the picture at this side" />
              ))
            )}
          </div>
        </Field>
        <Field label="Fill new space with">
          <select className="select ph-select" value={fill} onChange={(ev) => setFill(ev.target.value as any)}>
            <option value="transparent">Transparency</option>
            <option value="white">White</option>
            <option value="black">Black</option>
            <option value="background">Background colour</option>
          </select>
        </Field>
      </div>
    </Modal>
  );
}

function RotateDialog({ e, close }: { e: Engine; close(): void }) {
  const [deg, setDeg] = useState(15);
  const [cw, setCw] = useState(true);
  return (
    <Modal title="Rotate canvas" onClose={close} actions={<Actions onCancel={close} onOk={() => run(() => ops.rotateImage(e, cw ? deg : -deg), close)} />}>
      <Slider label="Angle" value={deg} min={0} max={359.9} step={0.1} unit="°" onChange={setDeg} />
      <Seg
        value={cw ? 'cw' : 'ccw'}
        options={[
          { id: 'cw', label: 'Clockwise' },
          { id: 'ccw', label: 'Counter-clockwise' }
        ]}
        onChange={(v) => setCw(v === 'cw')}
      />
      <p className="ph-hint">The canvas grows to fit the rotated picture. Text and shape layers become pixels.</p>
    </Modal>
  );
}

function ModifyDialog({ e, op, close }: { e: Engine; op: 'feather' | 'expand' | 'contract' | 'border'; close(): void }) {
  const [px, setPx] = useState(op === 'border' ? 10 : 5);
  const titles = { feather: 'Feather selection', expand: 'Expand selection', contract: 'Contract selection', border: 'Border selection' };
  return (
    <Modal title={titles[op]} onClose={close} actions={<Actions onCancel={close} onOk={() => run(() => ops.modifySelection(e, op, px), close)} />}>
      <Slider label={op === 'feather' ? 'Feather radius' : op === 'border' ? 'Width' : 'By'} value={px} min={op === 'feather' ? 0.1 : 1} max={op === 'feather' ? 250 : 500} step={op === 'feather' ? 0.1 : 1} unit="px" onChange={setPx} />
    </Modal>
  );
}

function BlendSelect({ value, onChange }: { value: LayerBlend; onChange(b: LayerBlend): void }) {
  return (
    <select className="select ph-select" value={value} onChange={(ev) => onChange(ev.target.value as LayerBlend)}>
      {BLEND_MODES.map((b) => (
        <option key={b.id} value={b.id}>
          {b.label}
        </option>
      ))}
    </select>
  );
}

function FillDialog({ e, close }: { e: Engine; close(): void }) {
  const [what, setWhat] = useState<'fg' | 'bg' | 'black' | 'white' | 'gray' | 'custom'>('fg');
  const [custom, setCustom] = useState('#ff0000');
  const [opacity, setOpacity] = useState(100);
  const [blend, setBlend] = useState<LayerBlend>('normal');
  const color = { fg: e.fg, bg: e.bg, black: '#000000', white: '#ffffff', gray: '#808080', custom }[what];
  return (
    <Modal title="Fill" onClose={close} actions={<Actions onCancel={close} onOk={() => run(() => ops.fill(e, color, opacity / 100, blend), close)} />}>
      <Field label="Contents">
        <select className="select ph-select" value={what} onChange={(ev) => setWhat(ev.target.value as any)}>
          <option value="fg">Foreground colour</option>
          <option value="bg">Background colour</option>
          <option value="black">Black</option>
          <option value="white">White</option>
          <option value="gray">50% gray</option>
          <option value="custom">Colour…</option>
        </select>
      </Field>
      {what === 'custom' && <ColorInput value={custom} onChange={setCustom} />}
      <Field label="Mode">
        <BlendSelect value={blend} onChange={setBlend} />
      </Field>
      <Slider label="Opacity" value={opacity} min={1} max={100} unit="%" onChange={setOpacity} />
      <p className="ph-hint">{e.selection ? 'Fills the selection.' : 'Nothing is selected, so the whole layer is filled.'}</p>
    </Modal>
  );
}

function StrokeDialog({ e, close }: { e: Engine; close(): void }) {
  const [w, setW] = useState(4);
  const [color, setColor] = useState(e.fg);
  const [where, setWhere] = useState<'inside' | 'center' | 'outside'>('center');
  return (
    <Modal title="Stroke selection" onClose={close} actions={<Actions onCancel={close} onOk={() => run(() => ops.strokeSelection(e, w, color, where), close)} />}>
      <Slider label="Width" value={w} min={1} max={250} unit="px" onChange={setW} />
      <Field label="Colour">
        <ColorInput value={color} onChange={setColor} />
      </Field>
      <Field label="Location">
        <Seg
          value={where}
          options={[
            { id: 'inside', label: 'Inside' },
            { id: 'center', label: 'Center' },
            { id: 'outside', label: 'Outside' }
          ]}
          onChange={setWhere}
        />
      </Field>
    </Modal>
  );
}

function ColorRangeDialog({ e, close }: { e: Engine; close(): void }) {
  const [color, setColor] = useState(e.fg);
  const [fuzz, setFuzz] = useState(40);
  const [mode, setMode] = useState<SelMode>('new');
  const orig = useRef(e.selection);
  const done = useRef(false);
  // Show the selection live; restore the old one on cancel.
  useEffect(() => {
    const t = setTimeout(() => {
      e.state.selection = orig.current;
      const px = ops.samplePixels(e, true);
      if (done.current) return;
      e.state.selection = S.combine(orig.current, S.colorRangeMask(px, hexToRgb(color), fuzz * 2.55), mode);
      e.requestFrame();
      e.emit();
    }, 120);
    return () => clearTimeout(t);
  }, [color, fuzz, mode]);
  const cancel = () => {
    done.current = true;
    e.state.selection = orig.current;
    e.requestFrame();
    e.emit();
    close();
  };
  const ok = () => {
    done.current = true;
    e.state.selection = orig.current;
    run(() => ops.colorRange(e, color, fuzz * 2.55, mode), close);
  };
  return (
    <Modal title="Color range" onClose={cancel} actions={<Actions onCancel={cancel} onOk={ok} />}>
      <Field label="Select colour (use the eyedropper first to pick it from the image)">
        <ColorInput value={color} onChange={setColor} />
      </Field>
      <Slider label="Fuzziness" value={fuzz} min={1} max={100} onChange={setFuzz} />
      <Seg
        value={mode}
        options={[
          { id: 'new', label: 'New' },
          { id: 'add', label: 'Add' },
          { id: 'subtract', label: 'Subtract' },
          { id: 'intersect', label: 'Intersect' }
        ]}
        onChange={setMode}
      />
    </Modal>
  );
}

function FadeDialog({ e, close }: { e: Engine; close(): void }) {
  const [opacity, setOpacity] = useState(100);
  const [blend, setBlend] = useState<LayerBlend>('normal');
  useEffect(() => {
    run(() => ops.fade(e, opacity / 100, blend, false));
  }, [opacity, blend]);
  const cancel = () => {
    e.preview = null;
    e.invalidate();
    close();
  };
  return (
    <Modal title={`Fade ${e.lastFilter?.label || ''}`} onClose={cancel} actions={<Actions onCancel={cancel} onOk={() => run(() => ops.fade(e, opacity / 100, blend, true), close)} />}>
      <Slider label="Opacity" value={opacity} min={0} max={100} unit="%" onChange={setOpacity} />
      <Field label="Mode">
        <BlendSelect value={blend} onChange={setBlend} />
      </Field>
    </Modal>
  );
}

function ExportDialog({ e, tabName, close }: { e: Engine; tabName: string; close(): void }) {
  const [fmt, setFmt] = useState<'png' | 'jpg' | 'webp' | 'psd'>('png');
  const [quality, setQuality] = useState(90);
  const names = { png: 'PNG image', jpg: 'JPEG image', webp: 'WebP image', psd: 'Photoshop document (layers)' };
  const go = () => exportFile(`${baseName(tabName)}.${fmt}`, { name: names[fmt], ext: fmt, build: () => encode(e, fmt, quality / 100) });
  return (
    <Modal title="Export a copy" onClose={close} actions={<Actions onCancel={close} onOk={() => run(go, close)} ok="Export…" />}>
      <Field label="Format">
        <Seg
          value={fmt}
          options={[
            { id: 'png', label: 'PNG' },
            { id: 'jpg', label: 'JPEG' },
            { id: 'webp', label: 'WebP' },
            { id: 'psd', label: 'PSD' }
          ]}
          onChange={setFmt}
        />
      </Field>
      {(fmt === 'jpg' || fmt === 'webp') && <Slider label="Quality" value={quality} min={1} max={100} onChange={setQuality} />}
      <p className="ph-hint">
        {fmt === 'png' ? 'Lossless, keeps transparency.' : fmt === 'jpg' ? 'Smaller files for photos. Transparency becomes white.' : fmt === 'webp' ? 'Small files, keeps transparency.' : 'Keeps layers, masks, text and adjustment layers.'}
      </p>
    </Modal>
  );
}

