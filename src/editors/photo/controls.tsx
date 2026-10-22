import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { X, Plus, Trash2 } from 'lucide-react';
import type { Adjustment, Filter } from './types';
import type { Histogram, CurvePoints, GradientStop } from './adjustments';
import { curveLut, SELECTIVE_RANGES } from './adjustments';

/** Small form controls used by the photo editor's panels and dialogs. */

export function Slider({ label, value, min, max, step = 1, unit = '', onChange, onCommit }: { label: string; value: number; min: number; max: number; step?: number; unit?: string; onChange(v: number): void; onCommit?(): void }) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? String(Math.round(value * 100) / 100);
  return (
    <label className="ph-slider">
      <span className="ph-slider-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onPointerUp={() => onCommit?.()}
        onKeyUp={() => onCommit?.()}
      />
      <span className="ph-slider-num">
        <input
          className="num-input"
          value={shown}
          onFocus={() => setText(shown)}
          onChange={(e) => {
            setText(e.target.value);
            const v = parseFloat(e.target.value);
            if (isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
          }}
          onBlur={() => {
            setText(null);
            onCommit?.();
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        {unit && <span className="ph-unit">{unit}</span>}
      </span>
    </label>
  );
}

export function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange(v: boolean): void }) {
  return (
    <label className="ph-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="ph-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Seg<T extends string>({ value, options, onChange }: { value: T; options: { id: NoInfer<T>; label: ReactNode; title?: string }[]; onChange(v: NoInfer<T>): void }) {
  return (
    <div className="ph-seg">
      {options.map((o) => (
        <button key={o.id} className={o.id === value ? 'on' : ''} title={o.title} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ColorInput({ value, onChange }: { value: string; onChange(v: string): void }) {
  return (
    <span className="ph-color-input">
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
      <input className="input sm" value={value} onChange={(e) => /^#[0-9a-f]{6}$/i.test(e.target.value) && onChange(e.target.value)} />
    </span>
  );
}

export function NumberField({ value, onChange, min, max, width = 72 }: { value: number; onChange(v: number): void; min?: number; max?: number; width?: number }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      className="input sm"
      style={{ width }}
      value={text ?? String(Math.round(value * 100) / 100)}
      onChange={(e) => {
        setText(e.target.value);
        const v = parseFloat(e.target.value);
        if (isFinite(v)) onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v)));
      }}
      onBlur={() => setText(null)}
    />
  );
}

/** Modal dialog in the app's style. */
export function Modal({ title, onClose, children, actions, wide }: { title: string; onClose(): void; children: ReactNode; actions?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`dialog ph-dialog ${wide ? 'wide' : ''}`} onKeyDown={(e) => e.stopPropagation()}>
        <div className="ph-dialog-head">
          <h2>{title}</h2>
          <button className="icon-btn sm" onClick={onClose} title="Close">
            <X size={16} />
          </button>
        </div>
        <div className="ph-dialog-body">{children}</div>
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>
  );
}

// ---------- Histogram ----------
export function HistogramView({ hist, channel, height = 90, markers }: { hist: Histogram | null; channel: 'rgb' | 'red' | 'green' | 'blue'; height?: number; markers?: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !hist) return;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, 256, height);
    const data = channel === 'red' ? hist.r : channel === 'green' ? hist.g : channel === 'blue' ? hist.b : hist.l;
    // Scale to a high percentile so one spike doesn't flatten the rest.
    const sorted = Array.from(data).sort((a, b) => a - b);
    const top = Math.max(1, sorted[250]);
    g.fillStyle = channel === 'red' ? '#f28b82' : channel === 'green' ? '#81c995' : channel === 'blue' ? '#8ab4f8' : '#c4c7c5';
    for (let i = 0; i < 256; i++) {
      const v = Math.min(1, data[i] / top) * height;
      g.fillRect(i, height - v, 1, v);
    }
    if (markers) {
      g.fillStyle = 'rgba(255,255,255,0.6)';
      for (const m of markers) g.fillRect(Math.round(m), 0, 1, height);
    }
  }, [hist, channel, height, markers?.join(',')]);
  return <canvas ref={ref} className="ph-hist" width={256} height={height} />;
}

// ---------- Curves ----------
function CurveEditor({ points, onChange, channel }: { points: CurvePoints; onChange(p: CurvePoints): void; channel: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const [dragI, setDragI] = useState<number | null>(null);
  const S = 256;
  const lut = useMemo(() => curveLut(points), [points]);
  const path = useMemo(() => Array.from(lut, (v, i) => `${i ? 'L' : 'M'}${i},${S - v}`).join(''), [lut]);
  const toPt = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { input: Math.round(Math.min(255, Math.max(0, ((e.clientX - r.left) / r.width) * 255))), output: Math.round(Math.min(255, Math.max(0, (1 - (e.clientY - r.top) / r.height) * 255))) };
  };
  const color = channel === 'red' ? '#f28b82' : channel === 'green' ? '#81c995' : channel === 'blue' ? '#8ab4f8' : '#e3e3e3';
  return (
    <svg
      ref={ref}
      className="ph-curve"
      viewBox={`0 0 ${S} ${S}`}
      onPointerDown={(e) => {
        try {
          (e.target as Element).setPointerCapture?.(e.pointerId);
        } catch {
          /* pointer already gone */
        }
        const p = toPt(e);
        const near = points.findIndex((q) => Math.abs(q.input - p.input) < 10 && Math.abs(q.output - p.output) < 14);
        if (near >= 0) return setDragI(near);
        const next = [...points, p].sort((a, b) => a.input - b.input);
        onChange(next);
        setDragI(next.indexOf(p));
      }}
      onPointerMove={(e) => {
        if (dragI == null) return;
        const p = toPt(e);
        const next = points.map((q, i) => (i === dragI ? p : q));
        // Keep points in order; a point dragged past a neighbour stops there.
        const prev = next[dragI - 1],
          nxt = next[dragI + 1];
        if (prev && p.input <= prev.input) p.input = prev.input + 1;
        if (nxt && p.input >= nxt.input) p.input = nxt.input - 1;
        onChange(next);
      }}
      onPointerUp={(e) => {
        if (dragI != null) {
          const r = ref.current!.getBoundingClientRect();
          const out = e.clientY < r.top - 20 || e.clientY > r.bottom + 20 || e.clientX < r.left - 20 || e.clientX > r.right + 20;
          // Drag a point off the graph to remove it (keeping at least two).
          if (out && points.length > 2) onChange(points.filter((_, i) => i !== dragI));
        }
        setDragI(null);
      }}
      onDoubleClick={(e) => {
        const p = toPt(e as any);
        const near = points.findIndex((q) => Math.abs(q.input - p.input) < 10 && Math.abs(q.output - p.output) < 14);
        if (near >= 0 && points.length > 2) onChange(points.filter((_, i) => i !== near));
      }}
    >
      {[64, 128, 192].map((v) => (
        <g key={v} stroke="rgba(255,255,255,0.12)">
          <line x1={v} y1={0} x2={v} y2={S} />
          <line x1={0} y1={v} x2={S} y2={v} />
        </g>
      ))}
      <line x1={0} y1={S} x2={S} y2={0} stroke="rgba(255,255,255,0.2)" />
      <path d={path} fill="none" stroke={color} strokeWidth={2} />
      {points.map((p, i) => (
        <rect key={i} x={p.input - 4} y={S - p.output - 4} width={8} height={8} fill={i === dragI ? color : '#1b1c1d'} stroke={color} strokeWidth={1.5} />
      ))}
    </svg>
  );
}

// ---------- Adjustment settings ----------
const CH = [
  { id: 'rgb', label: 'RGB' },
  { id: 'red', label: 'Red' },
  { id: 'green', label: 'Green' },
  { id: 'blue', label: 'Blue' }
] as { id: 'rgb' | 'red' | 'green' | 'blue'; label: string }[];

/** Settings editor for any adjustment. Calls `onChange` with a new object on every change; `onCommit` when a drag ends. */
export function AdjustmentControls({ adj, onChange, onCommit, hist }: { adj: Adjustment; onChange(a: Adjustment): void; onCommit?(): void; hist?: Histogram | null }) {
  const [ch, setCh] = useState<'rgb' | 'red' | 'green' | 'blue'>('rgb');
  const [tone, setTone] = useState<'shadows' | 'midtones' | 'highlights'>('midtones');
  const [out, setOut] = useState<'red' | 'green' | 'blue'>('red');
  const [range, setRange] = useState<(typeof SELECTIVE_RANGES)[number]>('reds');
  const set = (patch: Record<string, any>) => onChange({ ...adj, ...patch });
  const sl = (key: string, label: string, min: number, max: number, step = 1, unit = '') => <Slider key={key} label={label} value={adj[key]} min={min} max={max} step={step} unit={unit} onChange={(v) => set({ [key]: v })} onCommit={onCommit} />;
  switch (adj.type) {
    case 'brightness':
      return (
        <>
          {sl('brightness', 'Brightness', -150, 150)}
          {sl('contrast', 'Contrast', -50, 100)}
        </>
      );
    case 'levels': {
      const c = adj[ch];
      const up = (patch: Record<string, number>) => set({ [ch]: { ...c, ...patch } });
      return (
        <>
          <Seg value={ch} options={CH} onChange={setCh} />
          <HistogramView hist={hist || null} channel={ch} markers={[c.shadowInput, c.highlightInput]} />
          <Slider label="Shadows in" value={c.shadowInput} min={0} max={253} onChange={(v) => up({ shadowInput: Math.min(v, c.highlightInput - 2) })} onCommit={onCommit} />
          <Slider label="Midtones (gamma)" value={c.midtoneInput} min={0.1} max={9.99} step={0.01} onChange={(v) => up({ midtoneInput: v })} onCommit={onCommit} />
          <Slider label="Highlights in" value={c.highlightInput} min={2} max={255} onChange={(v) => up({ highlightInput: Math.max(v, c.shadowInput + 2) })} onCommit={onCommit} />
          <Slider label="Output black" value={c.shadowOutput} min={0} max={255} onChange={(v) => up({ shadowOutput: v })} onCommit={onCommit} />
          <Slider label="Output white" value={c.highlightOutput} min={0} max={255} onChange={(v) => up({ highlightOutput: v })} onCommit={onCommit} />
        </>
      );
    }
    case 'curves':
      return (
        <>
          <Seg value={ch} options={CH} onChange={setCh} />
          <div className="ph-curve-wrap">
            {hist && (
              <div className="ph-curve-hist">
                <HistogramView hist={hist} channel={ch} height={256} />
              </div>
            )}
            <CurveEditor
              channel={ch}
              points={adj[ch]}
              onChange={(p) => {
                set({ [ch]: p });
              }}
            />
          </div>
          <p className="ph-hint">Click to add a point, drag to shape the curve, double-click or drag a point off the graph to remove it.</p>
          <button
            className="btn sm"
            onClick={() => {
              set({
                [ch]: [
                  { input: 0, output: 0 },
                  { input: 255, output: 255 }
                ]
              });
              onCommit?.();
            }}
          >
            Reset {CH.find((x) => x.id === ch)!.label}
          </button>
        </>
      );
    case 'exposure':
      return (
        <>
          {sl('exposure', 'Exposure', -5, 5, 0.01, 'stops')}
          {sl('offset', 'Offset', -0.5, 0.5, 0.001)}
          {sl('gamma', 'Gamma correction', 0.1, 3, 0.01)}
        </>
      );
    case 'vibrance':
      return (
        <>
          {sl('vibrance', 'Vibrance', -100, 100)}
          {sl('saturation', 'Saturation', -100, 100)}
        </>
      );
    case 'hueSat':
      return (
        <>
          <Check label="Colorize" checked={adj.colorize} onChange={(v) => (set({ colorize: v }), onCommit?.())} />
          {adj.colorize ? (
            <>
              {sl('colorHue', 'Hue', 0, 360, 1, '°')}
              {sl('colorSat', 'Saturation', 0, 100)}
            </>
          ) : (
            <>
              {sl('hue', 'Hue', -180, 180, 1, '°')}
              {sl('saturation', 'Saturation', -100, 100)}
            </>
          )}
          {sl('lightness', 'Lightness', -100, 100)}
        </>
      );
    case 'colorBalance': {
      const v = adj[tone];
      const up = (k: string, n: number) => set({ [tone]: { ...v, [k]: n } });
      return (
        <>
          <Seg
            value={tone}
            options={[
              { id: 'shadows', label: 'Shadows' },
              { id: 'midtones', label: 'Midtones' },
              { id: 'highlights', label: 'Highlights' }
            ]}
            onChange={setTone}
          />
          <Slider label="Cyan ↔ Red" value={v.cyanRed} min={-100} max={100} onChange={(n) => up('cyanRed', n)} onCommit={onCommit} />
          <Slider label="Magenta ↔ Green" value={v.magentaGreen} min={-100} max={100} onChange={(n) => up('magentaGreen', n)} onCommit={onCommit} />
          <Slider label="Yellow ↔ Blue" value={v.yellowBlue} min={-100} max={100} onChange={(n) => up('yellowBlue', n)} onCommit={onCommit} />
          <Check label="Preserve luminosity" checked={adj.preserveLuminosity} onChange={(b) => (set({ preserveLuminosity: b }), onCommit?.())} />
        </>
      );
    }
    case 'bw':
      return (
        <>
          {sl('reds', 'Reds', -200, 300, 1, '%')}
          {sl('yellows', 'Yellows', -200, 300, 1, '%')}
          {sl('greens', 'Greens', -200, 300, 1, '%')}
          {sl('cyans', 'Cyans', -200, 300, 1, '%')}
          {sl('blues', 'Blues', -200, 300, 1, '%')}
          {sl('magentas', 'Magentas', -200, 300, 1, '%')}
          <div className="ph-row">
            <Check label="Tint" checked={adj.useTint} onChange={(b) => (set({ useTint: b }), onCommit?.())} />
            {adj.useTint && <ColorInput value={adj.tintColor} onChange={(c) => (set({ tintColor: c }), onCommit?.())} />}
          </div>
        </>
      );
    case 'photoFilter':
      return (
        <>
          <Field label="Filter colour">
            <ColorInput value={adj.color} onChange={(c) => (set({ color: c }), onCommit?.())} />
          </Field>
          <div className="ph-chips">
            {[
              ['Warming', '#ec8a00'],
              ['Cooling', '#006dff'],
              ['Sepia', '#ac7a33'],
              ['Green', '#19c919'],
              ['Red', '#ea1a1a']
            ].map(([n, c]) => (
              <button key={n} className="btn tonal sm" onClick={() => (set({ color: c }), onCommit?.())}>
                <span className="ph-dot" style={{ background: c }} /> {n}
              </button>
            ))}
          </div>
          {sl('density', 'Density', 0, 100, 1, '%')}
          <Check label="Preserve luminosity" checked={adj.preserveLuminosity} onChange={(b) => (set({ preserveLuminosity: b }), onCommit?.())} />
        </>
      );
    case 'channelMixer': {
      const key = adj.monochrome ? 'gray' : out;
      const m = adj[key];
      const up = (k: string, n: number) => set({ [key]: { ...m, [k]: n } });
      return (
        <>
          <Check label="Monochrome" checked={adj.monochrome} onChange={(b) => (set({ monochrome: b }), onCommit?.())} />
          {!adj.monochrome && (
            <Seg
              value={out}
              options={[
                { id: 'red', label: 'Red out' },
                { id: 'green', label: 'Green out' },
                { id: 'blue', label: 'Blue out' }
              ]}
              onChange={setOut}
            />
          )}
          <Slider label="Red" value={m.red} min={-200} max={200} unit="%" onChange={(n) => up('red', n)} onCommit={onCommit} />
          <Slider label="Green" value={m.green} min={-200} max={200} unit="%" onChange={(n) => up('green', n)} onCommit={onCommit} />
          <Slider label="Blue" value={m.blue} min={-200} max={200} unit="%" onChange={(n) => up('blue', n)} onCommit={onCommit} />
          <Slider label="Constant" value={m.constant} min={-200} max={200} unit="%" onChange={(n) => up('constant', n)} onCommit={onCommit} />
        </>
      );
    }
    case 'invert':
      return <p className="ph-hint">Inverts every colour. There are no settings.</p>;
    case 'posterize':
      return sl('levels', 'Levels', 2, 64);
    case 'threshold':
      return (
        <>
          <HistogramView hist={hist || null} channel="rgb" markers={[adj.level]} />
          {sl('level', 'Threshold level', 1, 255)}
        </>
      );
    case 'gradientMap':
      return <GradientStops stops={adj.stops} reverse={adj.reverse} onChange={(stops, reverse) => (set({ stops, reverse }), onCommit?.())} />;
    case 'selectiveColor': {
      const v = adj[range];
      const up = (k: string, n: number) => set({ [range]: { ...v, [k]: n } });
      return (
        <>
          <Field label="Colors">
            <select className="select ph-select" value={range} onChange={(e) => setRange(e.target.value as any)}>
              {SELECTIVE_RANGES.map((r) => (
                <option key={r} value={r}>
                  {r[0].toUpperCase() + r.slice(1)}
                </option>
              ))}
            </select>
          </Field>
          <Slider label="Cyan" value={v.c} min={-100} max={100} unit="%" onChange={(n) => up('c', n)} onCommit={onCommit} />
          <Slider label="Magenta" value={v.m} min={-100} max={100} unit="%" onChange={(n) => up('m', n)} onCommit={onCommit} />
          <Slider label="Yellow" value={v.y} min={-100} max={100} unit="%" onChange={(n) => up('y', n)} onCommit={onCommit} />
          <Slider label="Black" value={v.k} min={-100} max={100} unit="%" onChange={(n) => up('k', n)} onCommit={onCommit} />
          <Seg
            value={adj.mode}
            options={[
              { id: 'relative', label: 'Relative' },
              { id: 'absolute', label: 'Absolute' }
            ]}
            onChange={(m) => (set({ mode: m }), onCommit?.())}
          />
        </>
      );
    }
  }
  return null;
}

const GRADIENT_PRESETS: { name: string; stops: GradientStop[] }[] = [
  { name: 'Black to white', stops: [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }] },
  { name: 'Sepia', stops: [{ pos: 0, color: '#1e1208' }, { pos: 0.5, color: '#8c6239' }, { pos: 1, color: '#f6e7c8' }] },
  { name: 'Duotone blue', stops: [{ pos: 0, color: '#0b1f4d' }, { pos: 1, color: '#9fe0ff' }] },
  { name: 'Sunset', stops: [{ pos: 0, color: '#2b1055' }, { pos: 0.45, color: '#d53369' }, { pos: 1, color: '#fbd786' }] },
  { name: 'Infrared', stops: [{ pos: 0, color: '#000000' }, { pos: 0.33, color: '#7a0177' }, { pos: 0.66, color: '#f768a1' }, { pos: 1, color: '#fff7f3' }] }
];

function GradientStops({ stops, reverse, onChange }: { stops: GradientStop[]; reverse: boolean; onChange(s: GradientStop[], reverse: boolean): void }) {
  const css = `linear-gradient(90deg, ${[...stops].sort((a, b) => a.pos - b.pos).map((s) => `${s.color} ${s.pos * 100}%`).join(', ')})`;
  return (
    <>
      <div className="ph-grad-bar" style={{ background: css, transform: reverse ? 'scaleX(-1)' : undefined }} />
      <div className="ph-chips">
        {GRADIENT_PRESETS.map((p) => (
          <button key={p.name} className="btn tonal sm" onClick={() => onChange(p.stops, reverse)}>
            {p.name}
          </button>
        ))}
      </div>
      {stops.map((s, i) => (
        <div key={i} className="ph-row">
          <input type="color" value={s.color} onChange={(e) => onChange(stops.map((x, j) => (j === i ? { ...x, color: e.target.value } : x)), reverse)} />
          <input type="range" min={0} max={100} value={Math.round(s.pos * 100)} onChange={(e) => onChange(stops.map((x, j) => (j === i ? { ...x, pos: parseInt(e.target.value) / 100 } : x)), reverse)} />
          <span className="ph-unit">{Math.round(s.pos * 100)}%</span>
          <button className="icon-btn sm" title="Remove this colour" disabled={stops.length <= 2} onClick={() => onChange(stops.filter((_, j) => j !== i), reverse)}>
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div className="ph-row">
        <button className="btn sm" onClick={() => onChange([...stops, { pos: 0.5, color: '#808080' }], reverse)}>
          <Plus size={14} /> Add colour
        </button>
        <Check label="Reverse" checked={reverse} onChange={(r) => onChange(stops, r)} />
      </div>
    </>
  );
}

// ---------- Filter settings ----------
export function FilterControls({ f, onChange }: { f: Filter; onChange(f: Filter): void }) {
  const set = (patch: Record<string, any>) => onChange({ ...f, ...patch });
  const sl = (key: string, label: string, min: number, max: number, step = 1, unit = '') => <Slider key={key} label={label} value={f[key]} min={min} max={max} step={step} unit={unit} onChange={(v) => set({ [key]: v })} />;
  switch (f.type) {
    case 'gaussian':
    case 'box':
      return sl('radius', 'Radius', 0, 100, 0.1, 'px');
    case 'motion':
      return (
        <>
          {sl('angle', 'Angle', -180, 180, 1, '°')}
          {sl('distance', 'Distance', 1, 200, 1, 'px')}
        </>
      );
    case 'radial':
      return (
        <>
          <Seg
            value={f.mode}
            options={[
              { id: 'zoom', label: 'Zoom' },
              { id: 'spin', label: 'Spin' }
            ]}
            onChange={(m) => set({ mode: m })}
          />
          {sl('amount', 'Amount', 1, 100)}
          {sl('cx', 'Centre across', 0, 1, 0.01)}
          {sl('cy', 'Centre down', 0, 1, 0.01)}
        </>
      );
    case 'unsharp':
      return (
        <>
          {sl('amount', 'Amount', 1, 500, 1, '%')}
          {sl('radius', 'Radius', 0.1, 50, 0.1, 'px')}
          {sl('threshold', 'Threshold', 0, 255, 1, 'levels')}
        </>
      );
    case 'sharpen':
      return sl('amount', 'Amount', 1, 200, 1, '%');
    case 'noise':
      return (
        <>
          {sl('amount', 'Amount', 0, 100, 0.5, '%')}
          <Seg
            value={f.gaussian ? 'g' : 'u'}
            options={[
              { id: 'u', label: 'Uniform' },
              { id: 'g', label: 'Gaussian' }
            ]}
            onChange={(v) => set({ gaussian: v === 'g' })}
          />
          <Check label="Monochromatic" checked={f.mono} onChange={(v) => set({ mono: v })} />
        </>
      );
    case 'median':
      return sl('radius', 'Radius', 1, 20, 1, 'px');
    case 'pixelate':
      return sl('size', 'Cell size', 2, 200, 1, 'px');
    case 'emboss':
      return (
        <>
          {sl('angle', 'Angle', -180, 180, 1, '°')}
          {sl('height', 'Height', 1, 10, 1, 'px')}
          {sl('amount', 'Amount', 1, 500, 1, '%')}
        </>
      );
    case 'edges':
      return <p className="ph-hint">Outlines edges in colour on a white background. There are no settings.</p>;
    case 'oil':
      return sl('radius', 'Brush size', 1, 20, 1, 'px');
    case 'vignette':
      return (
        <>
          {sl('amount', 'Amount (dark ↔ light)', -100, 100)}
          {sl('midpoint', 'Midpoint', 0, 100)}
          {sl('feather', 'Feather', 0, 100)}
          {sl('roundness', 'Roundness', 0, 100)}
        </>
      );
    case 'offset':
      return (
        <>
          {sl('dx', 'Horizontal', -2000, 2000, 1, 'px')}
          {sl('dy', 'Vertical', -2000, 2000, 1, 'px')}
          <Seg
            value={f.edge}
            options={[
              { id: 'wrap', label: 'Wrap around' },
              { id: 'repeat', label: 'Repeat edge' },
              { id: 'transparent', label: 'Transparent' }
            ]}
            onChange={(v) => set({ edge: v })}
          />
        </>
      );
  }
  return null;
}
