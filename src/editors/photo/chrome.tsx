import { useRef, useState, ReactNode } from 'react';
import {
  Move,
  SquareDashed,
  CircleDashed,
  Lasso,
  LassoSelect,
  WandSparkles,
  Wand,
  Crop,
  Pipette,
  Bandage,
  Paintbrush,
  Pencil,
  Stamp,
  Eraser,
  Blend,
  PaintBucket,
  Droplet,
  Triangle,
  Fingerprint,
  SunDim,
  Flame,
  Type,
  Shapes,
  Hand,
  ZoomIn,
  ZoomOut,
  ArrowLeftRight,
  Square,
  Circle,
  Minus,
  Hexagon,
  Check as CheckIcon,
  X,
  Bold,
  Italic,
  AlignLeft,
  AlignCenter,
  AlignRight
} from 'lucide-react';
import type { Engine } from './engine';
import type { ToolId, BrushOpts, GradientPreset } from './toolOptions';
import { TOOL_GROUPS, TOOL_NAMES, brushKey } from './toolOptions';
import type { SelMode } from './selection';
import { Popover } from '../../components/Popover';
import { PALETTE } from '../../components/ColorPicker';
import { FONTS, renderText } from './vector';
import * as ops from './ops';
import { endText } from './tools';
import { toast } from '../../store';

/** Photoshop-style chrome: the tool strip, colour wells and the per-tool options bar. */

export const TOOL_ICONS: Record<ToolId, any> = {
  move: Move,
  'marquee-rect': SquareDashed,
  'marquee-ellipse': CircleDashed,
  lasso: Lasso,
  'lasso-poly': LassoSelect,
  wand: WandSparkles,
  quick: Wand,
  crop: Crop,
  eyedropper: Pipette,
  heal: Bandage,
  brush: Paintbrush,
  pencil: Pencil,
  clone: Stamp,
  eraser: Eraser,
  gradient: Blend,
  bucket: PaintBucket,
  blur: Droplet,
  sharpen: Triangle,
  smudge: Fingerprint,
  dodge: SunDim,
  burn: Flame,
  text: Type,
  shape: Shapes,
  hand: Hand,
  zoom: ZoomIn
};

const act = (fn: () => unknown) => {
  try {
    const r = fn();
    if (r instanceof Promise) r.catch((err) => toast(err?.message || String(err), 'error'));
  } catch (err: any) {
    toast(err?.message || String(err), 'error');
  }
};

export function selectTool(e: Engine, t: ToolId) {
  if (e.textEditing) endText(e);
  if (e.tool === 'crop' && t !== 'crop') e.crop = null;
  if (e.overlay?.kind === 'poly') e.overlay = null;
  e.tool = t;
  e.requestFrame();
  e.emit();
}

// ---------- Tool strip ----------
export function ToolStrip({ e }: { e: Engine }) {
  const [flyout, setFlyout] = useState<{ i: number; anchor: HTMLElement } | null>(null);
  const lastInGroup = useRef<Record<number, ToolId>>({});
  return (
    <div className="ph-tools">
      {TOOL_GROUPS.map((g, i) => {
        const current = g.tools.includes(e.tool) ? e.tool : lastInGroup.current[i] || g.tools[0];
        if (g.tools.includes(e.tool)) lastInGroup.current[i] = e.tool;
        const Icon = TOOL_ICONS[current];
        const multi = g.tools.length > 1;
        return (
          <button
            key={g.key}
            className={`ph-tool ${g.tools.includes(e.tool) ? 'on' : ''}`}
            title={`${TOOL_NAMES[current]} (${g.key})${multi ? ` · right-click for more, Shift+${g.key} to switch` : ''}`}
            onClick={() => selectTool(e, current)}
            onContextMenu={(ev) => {
              ev.preventDefault();
              if (multi) setFlyout({ i, anchor: ev.currentTarget });
            }}
          >
            <Icon size={18} />
            {multi && <span className="ph-tool-more" />}
          </button>
        );
      })}
      <Popover anchor={flyout?.anchor || null} open={!!flyout} onClose={() => setFlyout(null)}>
        {flyout &&
          TOOL_GROUPS[flyout.i].tools.map((t) => {
            const Icon = TOOL_ICONS[t];
            return (
              <button
                key={t}
                className="menu-item"
                onClick={() => {
                  selectTool(e, t);
                  setFlyout(null);
                }}
              >
                <Icon size={16} /> {TOOL_NAMES[t]} <span className="kbd">{TOOL_GROUPS[flyout.i].key}</span>
              </button>
            );
          })}
      </Popover>
      <ColorWells e={e} />
    </div>
  );
}

function ColorWells({ e }: { e: Engine }) {
  const [edit, setEdit] = useState<{ which: 'fg' | 'bg'; anchor: HTMLElement } | null>(null);
  const val = edit ? e[edit.which] : '#000000';
  const set = (c: string) => {
    if (!edit) return;
    e[edit.which] = c;
    e.emit();
  };
  return (
    <div className="ph-wells">
      <button className="ph-well bg" style={{ background: e.bg }} title="Background colour" onClick={(ev) => setEdit({ which: 'bg', anchor: ev.currentTarget })} />
      <button className="ph-well fg" style={{ background: e.fg }} title="Foreground colour" onClick={(ev) => setEdit({ which: 'fg', anchor: ev.currentTarget })} />
      <button
        className="ph-well-swap"
        title="Swap colours (X)"
        onClick={() => {
          [e.fg, e.bg] = [e.bg, e.fg];
          e.emit();
        }}
      >
        <ArrowLeftRight size={11} />
      </button>
      <button
        className="ph-well-reset"
        title="Default black and white (D)"
        onClick={() => {
          e.fg = '#000000';
          e.bg = '#ffffff';
          e.emit();
        }}
      />
      <Popover anchor={edit?.anchor || null} open={!!edit} onClose={() => setEdit(null)}>
        {edit && (
          <div className="ph-color-pop">
            <div className="menu-title">{edit.which === 'fg' ? 'Foreground colour' : 'Background colour'}</div>
            <div className="swatches">
              {PALETTE.map((c) => (
                <button key={c} className="swatch" style={{ background: c, outline: val === c ? '2px solid var(--accent)' : undefined }} onClick={() => set(c)} title={c} />
              ))}
            </div>
            <div className="ph-row" style={{ padding: '4px 6px' }}>
              <input type="color" value={val} onChange={(ev) => set(ev.target.value)} />
              <input className="input sm" value={val} onChange={(ev) => /^#[0-9a-f]{6}$/i.test(ev.target.value) && set(ev.target.value.toLowerCase())} />
            </div>
          </div>
        )}
      </Popover>
    </div>
  );
}

// ---------- Options bar ----------
function Num({ label, value, min, max, step = 1, unit = '', onChange, title, width = 64 }: { label?: string; value: number; min: number; max: number; step?: number; unit?: string; onChange(v: number): void; title?: string; width?: number }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <label className="ph-opt" title={title}>
      {label && <span className="tb-label">{label}</span>}
      <input type="range" min={min} max={max} step={step} value={value} style={{ width }} onChange={(ev) => onChange(parseFloat(ev.target.value))} />
      <input
        className="num-input"
        value={text ?? String(Math.round(value * 100) / 100)}
        onChange={(ev) => {
          setText(ev.target.value);
          const v = parseFloat(ev.target.value);
          if (isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
        }}
        onBlur={() => setText(null)}
        onKeyDown={(ev) => {
          ev.stopPropagation();
          if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
        }}
      />
      {unit && <span className="ph-unit">{unit}</span>}
    </label>
  );
}

function Toggle({ label, on, onChange, title }: { label: ReactNode; on: boolean; onChange(v: boolean): void; title?: string }) {
  return (
    <label className="ph-opt ph-opt-check" title={title}>
      <input type="checkbox" checked={on} onChange={(ev) => onChange(ev.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function SelModes({ e }: { e: Engine }) {
  const modes: { id: SelMode; label: string; title: string }[] = [
    { id: 'new', label: 'New', title: 'New selection' },
    { id: 'add', label: 'Add', title: 'Add to selection (Shift)' },
    { id: 'subtract', label: 'Subtract', title: 'Subtract from selection (Alt)' },
    { id: 'intersect', label: 'Intersect', title: 'Intersect with selection (Shift+Alt)' }
  ];
  return (
    <div className="ph-seg">
      {modes.map((m) => (
        <button
          key={m.id}
          className={e.opts.selMode === m.id ? 'on' : ''}
          title={m.title}
          onClick={() => {
            e.opts.selMode = m.id;
            e.emit();
          }}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

export function OptionsBar({ e, openDialog }: { e: Engine; openDialog(d: any): void }) {
  const o = e.opts;
  const up = () => e.emit();
  const t = e.tool;
  const Icon = TOOL_ICONS[t];

  if (e.transform && !e.transform.moveOnly) {
    const tr = e.transform;
    return (
      <div className="ph-options">
        <span className="ph-opt-title">Free transform</span>
        <span className="tb-label">
          W {Math.round(tr.sx * 100)}% · H {Math.round(tr.sy * 100)}% · {Math.round((tr.angle * 180) / Math.PI)}°
        </span>
        <span className="tb-label">Drag corners to scale (Shift keeps proportions), drag outside a corner to rotate.</span>
        <span className="tb-spacer" />
        <button className="btn sm" onClick={() => e.cancelTransform()}>
          <X size={14} /> Cancel
        </button>
        <button className="btn primary sm" onClick={() => act(() => ops.commitTransform(e))}>
          <CheckIcon size={14} /> Apply (Enter)
        </button>
      </div>
    );
  }

  const brush = (key: NonNullable<ReturnType<typeof brushKey>>) => {
    const b = o[key] as BrushOpts;
    const set = (patch: Partial<BrushOpts>) => {
      o[key] = { ...(o[key] as any), ...patch };
      e.requestFrame();
      up();
    };
    return (
      <>
        <Num label="Size" value={b.size} min={1} max={1000} unit="px" onChange={(v) => set({ size: v })} title="Brush size ([ and ] to change)" />
        {t !== 'pencil' && <Num label="Hardness" value={Math.round(b.hardness * 100)} min={0} max={100} unit="%" onChange={(v) => set({ hardness: v / 100 })} />}
        {key !== 'toning' && key !== 'focus' && key !== 'heal' && <Num label="Opacity" value={Math.round(b.opacity * 100)} min={1} max={100} unit="%" onChange={(v) => set({ opacity: v / 100 })} />}
        {key !== 'heal' && key !== 'pencil' && <Num label={key === 'toning' || key === 'focus' ? 'Flow' : 'Flow'} value={Math.round(b.flow * 100)} min={1} max={100} unit="%" onChange={(v) => set({ flow: v / 100 })} />}
        {(key === 'brush' || key === 'eraser' || key === 'clone') && <Num label="Smoothing" value={Math.round(b.smoothing * 100)} min={0} max={100} unit="%" onChange={(v) => set({ smoothing: v / 100 })} />}
        <Toggle label="Pen size" on={b.pressureSize} onChange={(v) => set({ pressureSize: v })} title="Pen pressure controls the size" />
        <Toggle label="Pen opacity" on={b.pressureOpacity} onChange={(v) => set({ pressureOpacity: v })} title="Pen pressure controls the opacity" />
      </>
    );
  };

  let body: ReactNode = null;
  switch (t) {
    case 'move':
      body = (
        <>
          <Toggle
            label="Auto-select layer"
            on={o.move.autoSelect}
            onChange={(v) => {
              o.move.autoSelect = v;
              up();
            }}
            title="Click picks the layer under the pointer (hold Ctrl to do the opposite)"
          />
          <button className="btn tonal sm" onClick={() => act(() => ops.beginTransform(e))}>
            Free transform (Ctrl+T)
          </button>
          <button className="btn tonal sm" onClick={() => act(() => ops.flipLayer(e, 'h'))}>
            Flip layer ↔
          </button>
          <button className="btn tonal sm" onClick={() => act(() => ops.flipLayer(e, 'v'))}>
            Flip layer ↕
          </button>
        </>
      );
      break;
    case 'marquee-rect':
    case 'marquee-ellipse':
    case 'lasso':
    case 'lasso-poly':
      body = (
        <>
          <SelModes e={e} />
          <Num
            label="Feather"
            value={o.feather}
            min={0}
            max={250}
            unit="px"
            onChange={(v) => {
              o.feather = v;
              up();
            }}
          />
          {(t === 'marquee-rect' || t === 'marquee-ellipse') && (
            <label className="ph-opt">
              <span className="tb-label">Ratio</span>
              <input
                className="input sm"
                style={{ width: 70 }}
                placeholder="Free"
                value={o.ratio}
                onKeyDown={(ev) => ev.stopPropagation()}
                onChange={(ev) => {
                  o.ratio = ev.target.value;
                  up();
                }}
                title="Fixed ratio like 16:9, or leave empty"
              />
            </label>
          )}
          {t === 'lasso-poly' && <span className="tb-label">Click to add points · double-click or Enter to close · Backspace removes a point</span>}
          <button className="btn tonal sm" onClick={() => openDialog({ kind: 'modify', op: 'feather' })} disabled={!e.selection}>
            Refine…
          </button>
        </>
      );
      break;
    case 'wand':
    case 'quick':
      body = (
        <>
          <SelModes e={e} />
          {t === 'quick' && (
            <Num
              label="Size"
              value={o.quickSize}
              min={2}
              max={300}
              unit="px"
              onChange={(v) => {
                o.quickSize = v;
                e.requestFrame();
                up();
              }}
            />
          )}
          <Num
            label="Tolerance"
            value={o.wandTolerance}
            min={0}
            max={255}
            onChange={(v) => {
              o.wandTolerance = v;
              up();
            }}
          />
          {t === 'wand' && (
            <Toggle
              label="Contiguous"
              on={o.wandContiguous}
              onChange={(v) => {
                o.wandContiguous = v;
                up();
              }}
            />
          )}
          <Toggle
            label="All layers"
            on={o.sampleAll}
            onChange={(v) => {
              o.sampleAll = v;
              up();
            }}
            title="Look at the whole picture, not just the active layer"
          />
          {t === 'wand' && (
            <Toggle
              label="Smooth edges"
              on={o.antialias}
              onChange={(v) => {
                o.antialias = v;
                up();
              }}
            />
          )}
          <button className="btn tonal sm" onClick={() => openDialog({ kind: 'colorRange' })}>
            Color range…
          </button>
        </>
      );
      break;
    case 'crop':
      body = (
        <>
          <label className="ph-opt">
            <span className="tb-label">Ratio</span>
            <select
              className="select"
              value={o.ratio}
              onChange={(ev) => {
                o.ratio = ev.target.value;
                up();
              }}
            >
              <option value="">Free</option>
              <option value="1:1">Square 1:1</option>
              <option value="4:3">4:3</option>
              <option value="3:2">3:2</option>
              <option value="16:9">16:9</option>
              <option value="9:16">9:16</option>
              <option value="4:5">4:5</option>
            </select>
          </label>
          <span className="tb-label">Drag the box or its handles · double-click inside or Enter to crop</span>
          {e.crop && (
            <>
              <button
                className="btn sm"
                onClick={() => {
                  e.crop = null;
                  e.requestFrame();
                  up();
                }}
              >
                <X size={14} /> Cancel
              </button>
              <button className="btn primary sm" onClick={() => act(() => ops.cropTo(e, e.crop!))}>
                <CheckIcon size={14} /> Crop
              </button>
            </>
          )}
        </>
      );
      break;
    case 'eyedropper':
      body = (
        <>
          <label className="ph-opt">
            <span className="tb-label">Sample</span>
            <select
              className="select"
              value={o.eyedropper.size}
              onChange={(ev) => {
                o.eyedropper.size = +ev.target.value as 1;
                up();
              }}
            >
              <option value={1}>Point</option>
              <option value={3}>3 × 3 average</option>
              <option value={5}>5 × 5 average</option>
            </select>
          </label>
          <Toggle
            label="All layers"
            on={o.eyedropper.sampleAll}
            onChange={(v) => {
              o.eyedropper.sampleAll = v;
              up();
            }}
          />
          <span className="tb-label">Alt+click picks the background colour</span>
        </>
      );
      break;
    case 'brush':
    case 'pencil':
    case 'eraser':
    case 'heal':
      body = brush(brushKey(t)!);
      break;
    case 'clone':
      body = (
        <>
          {brush('clone')}
          <Toggle
            label="Aligned"
            on={o.clone.aligned}
            onChange={(v) => {
              o.clone.aligned = v;
              up();
            }}
          />
          <Toggle
            label="All layers"
            on={o.clone.sampleAll}
            onChange={(v) => {
              o.clone.sampleAll = v;
              up();
            }}
          />
          <span className="tb-label">Alt+click sets the source</span>
        </>
      );
      break;
    case 'dodge':
    case 'burn':
      body = (
        <>
          {brush('toning')}
          <label className="ph-opt">
            <span className="tb-label">Range</span>
            <select
              className="select"
              value={o.toning.range}
              onChange={(ev) => {
                o.toning = { ...o.toning, range: ev.target.value as any };
                up();
              }}
            >
              <option value="shadows">Shadows</option>
              <option value="midtones">Midtones</option>
              <option value="highlights">Highlights</option>
            </select>
          </label>
          <Num
            label="Exposure"
            value={Math.round(o.toning.exposure * 100)}
            min={1}
            max={100}
            unit="%"
            onChange={(v) => {
              o.toning = { ...o.toning, exposure: v / 100 };
              up();
            }}
          />
        </>
      );
      break;
    case 'blur':
    case 'sharpen':
    case 'smudge':
      body = (
        <>
          {brush('focus')}
          <Num
            label="Strength"
            value={Math.round(o.focus.strength * 100)}
            min={1}
            max={100}
            unit="%"
            onChange={(v) => {
              o.focus = { ...o.focus, strength: v / 100 };
              up();
            }}
          />
        </>
      );
      break;
    case 'bucket':
      body = (
        <>
          <Num
            label="Tolerance"
            value={o.bucket.tolerance}
            min={0}
            max={255}
            onChange={(v) => {
              o.bucket.tolerance = v;
              up();
            }}
          />
          <Num
            label="Opacity"
            value={Math.round(o.bucket.opacity * 100)}
            min={1}
            max={100}
            unit="%"
            onChange={(v) => {
              o.bucket.opacity = v / 100;
              up();
            }}
          />
          <Toggle
            label="Contiguous"
            on={o.bucket.contiguous}
            onChange={(v) => {
              o.bucket.contiguous = v;
              up();
            }}
          />
          <Toggle
            label="All layers"
            on={o.bucket.sampleAll}
            onChange={(v) => {
              o.bucket.sampleAll = v;
              up();
            }}
          />
          <Toggle
            label="Smooth edges"
            on={o.bucket.antialias}
            onChange={(v) => {
              o.bucket.antialias = v;
              up();
            }}
          />
        </>
      );
      break;
    case 'gradient':
      body = (
        <>
          <div className="ph-seg">
            {(['linear', 'radial'] as const).map((k) => (
              <button
                key={k}
                className={o.gradient.type === k ? 'on' : ''}
                onClick={() => {
                  o.gradient.type = k;
                  up();
                }}
              >
                {k === 'linear' ? 'Linear' : 'Radial'}
              </button>
            ))}
          </div>
          <label className="ph-opt">
            <span className="tb-label">Colours</span>
            <select
              className="select"
              value={o.gradient.preset}
              onChange={(ev) => {
                o.gradient.preset = ev.target.value as GradientPreset;
                up();
              }}
            >
              <option value="fg-bg">Foreground to background</option>
              <option value="fg-transparent">Foreground to transparent</option>
              <option value="black-white">Black to white</option>
              <option value="rainbow">Rainbow</option>
              <option value="sunset">Sunset</option>
              <option value="chrome">Chrome</option>
            </select>
          </label>
          <Toggle
            label="Reverse"
            on={o.gradient.reverse}
            onChange={(v) => {
              o.gradient.reverse = v;
              up();
            }}
          />
          <Num
            label="Opacity"
            value={Math.round(o.gradient.opacity * 100)}
            min={1}
            max={100}
            unit="%"
            onChange={(v) => {
              o.gradient.opacity = v / 100;
              up();
            }}
          />
          <span className="tb-label">Drag across the image (Shift snaps to 45°)</span>
        </>
      );
      break;
    case 'text': {
      // Changes apply to the text layer being edited/selected, and become the defaults for new text.
      const l = e.active && e.active.kind === 'text' ? e.active : null;
      const setText = (patch: Partial<typeof o.text> & { color?: string }) => {
        const { color, ...rest } = patch;
        o.text = { ...o.text, ...rest };
        if (color) e.fg = color;
        if (l) {
          l.text = { ...l.text, ...rest, ...(color ? { color } : {}) };
          renderText(l);
          e.invalidate();
          if (!e.textEditing) e.commit('Text settings');
        }
        up();
      };
      const cur = l ? l.text : { ...o.text, color: e.fg };
      body = (
        <>
          <select className="select" value={cur.font} onChange={(ev) => setText({ font: ev.target.value })} title="Font">
            {(FONTS.includes(cur.font) ? FONTS : [cur.font, ...FONTS]).map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <Num value={Math.round(cur.size)} min={4} max={500} unit="px" onChange={(v) => setText({ size: v })} title="Font size" />
          <button className={`icon-btn sm ${cur.bold ? 'active' : ''}`} title="Bold" onClick={() => setText({ bold: !cur.bold })}>
            <Bold size={15} />
          </button>
          <button className={`icon-btn sm ${cur.italic ? 'active' : ''}`} title="Italic" onClick={() => setText({ italic: !cur.italic })}>
            <Italic size={15} />
          </button>
          {(['left', 'center', 'right'] as const).map((a) => {
            const AI = a === 'left' ? AlignLeft : a === 'center' ? AlignCenter : AlignRight;
            return (
              <button key={a} className={`icon-btn sm ${cur.align === a ? 'active' : ''}`} title={`Align ${a}`} onClick={() => setText({ align: a })}>
                <AI size={15} />
              </button>
            );
          })}
          <label className="ph-opt" title="Text colour">
            <input type="color" value={cur.color} onChange={(ev) => setText({ color: ev.target.value })} />
          </label>
          <span className="tb-label">{e.textEditing ? 'Typing · Ctrl+Enter to finish, Esc to cancel' : 'Click to add text, or click existing text to edit it'}</span>
        </>
      );
      break;
    }
    case 'shape': {
      const s = o.shape;
      const set = (patch: Partial<typeof s>) => {
        o.shape = { ...s, ...patch };
        up();
      };
      const kinds = [
        { id: 'rect', Icon: Square, label: 'Rectangle' },
        { id: 'ellipse', Icon: Circle, label: 'Ellipse' },
        { id: 'polygon', Icon: Hexagon, label: 'Polygon' },
        { id: 'line', Icon: Minus, label: 'Line' }
      ] as const;
      body = (
        <>
          {kinds.map(({ id, Icon: I, label }) => (
            <button key={id} className={`icon-btn sm ${s.type === id ? 'active' : ''}`} title={label} onClick={() => set({ type: id })}>
              <I size={15} />
            </button>
          ))}
          {s.type !== 'line' && <Toggle label="Fill (foreground)" on={s.fillOn} onChange={(v) => set({ fillOn: v })} />}
          <Toggle label={s.type === 'line' ? 'Custom colour' : 'Stroke'} on={s.strokeOn} onChange={(v) => set({ strokeOn: v })} />
          {(s.strokeOn || s.type === 'line') && (
            <>
              {s.strokeOn && (
                <label className="ph-opt">
                  <input type="color" value={s.stroke} onChange={(ev) => set({ stroke: ev.target.value })} />
                </label>
              )}
              <Num label="Width" value={s.strokeWidth} min={1} max={200} unit="px" onChange={(v) => set({ strokeWidth: v })} />
            </>
          )}
          {s.type === 'rect' && <Num label="Radius" value={s.radius} min={0} max={500} unit="px" onChange={(v) => set({ radius: v })} />}
          {s.type === 'polygon' && <Num label="Sides" value={s.sides} min={3} max={24} onChange={(v) => set({ sides: Math.round(v) })} />}
          <span className="tb-label">Shift keeps it square · Alt draws from the centre</span>
        </>
      );
      break;
    }
    case 'hand':
    case 'zoom':
      body = (
        <>
          <button className="icon-btn sm" title="Zoom out (Ctrl+-)" onClick={() => e.zoomStep(-1)}>
            <ZoomOut size={15} />
          </button>
          <button className="icon-btn sm" title="Zoom in (Ctrl++)" onClick={() => e.zoomStep(1)}>
            <ZoomIn size={15} />
          </button>
          <button className="btn tonal sm" onClick={() => e.zoomTo(1)}>
            100%
          </button>
          <button className="btn tonal sm" onClick={() => e.fitView()}>
            Fit on screen
          </button>
          {t === 'zoom' && <span className="tb-label">Click to zoom in, Alt+click to zoom out</span>}
        </>
      );
      break;
  }

  return (
    <div className="ph-options">
      <span className="ph-opt-title">
        <Icon size={15} /> {TOOL_NAMES[t]}
      </span>
      {body}
    </div>
  );
}
