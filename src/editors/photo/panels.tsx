import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  Eye,
  EyeOff,
  Lock,
  LockOpen,
  Folder,
  FolderOpen,
  ChevronDown,
  ChevronRight,
  Plus,
  FolderPlus,
  Trash2,
  Copy,
  SquareDashed,
  SlidersHorizontal,
  CornerLeftDown,
  Merge,
  Type,
  Shapes,
  Link2,
  Unlink2
} from 'lucide-react';
import type { Engine } from './engine';
import type { Layer, LayerBlend, AdjType, Mask } from './types';
import { BLEND_MODES, isPixelLayer } from './types';
import { ADJ_LABELS, ADJ_ORDER, adjDefaults, histogram } from './adjustments';
import { AdjustmentControls, Slider, Check, Field, Seg, ColorInput } from './controls';
import { MenuButton } from '../../components/Popover';
import { FONTS, renderText, renderShape } from './vector';
import * as ops from './ops';
import { getPixels, cloneCanvas } from './canvas';
import { toast } from '../../store';

/** Right-hand dock: Layers, Properties, Adjustments and History panels. */

const act = (fn: () => unknown) => {
  try {
    const r = fn();
    if (r instanceof Promise) r.catch((err) => toast(err?.message || String(err), 'error'));
  } catch (err: any) {
    toast(err?.message || String(err), 'error');
  }
};

export function DockSection({ id, title, icon, children, grow, open, onToggle, extra }: { id: string; title: string; icon: ReactNode; children: ReactNode; grow?: boolean; open: boolean; onToggle(id: string): void; extra?: ReactNode }) {
  return (
    <section className={`ph-sec ${open ? 'open' : ''} ${grow && open ? 'grow' : ''}`}>
      <div className="ph-sec-head" onClick={() => onToggle(id)}>
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {icon}
        <span>{title}</span>
        <span className="tb-spacer" />
        <span onClick={(ev) => ev.stopPropagation()}>{extra}</span>
      </div>
      {open && <div className="ph-sec-body">{children}</div>}
    </section>
  );
}

// ---------- Thumbnails ----------
function drawChecker(g: CanvasRenderingContext2D, w: number, h: number) {
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#d0d0d0';
  for (let y = 0; y < h; y += 4) for (let x = (y / 4) % 2 ? 4 : 0; x < w; x += 8) g.fillRect(x, y, 4, 4);
}

function Thumb({ e, layer }: { e: Engine; layer: Layer }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const src = isPixelLayer(layer) ? layer.canvas : null;
  const x = isPixelLayer(layer) ? layer.x : 0,
    y = isPixelLayer(layer) ? layer.y : 0;
  useEffect(() => {
    const c = ref.current;
    if (!c || !src) return;
    const S = 34;
    const s = Math.min(S / e.doc.w, S / e.doc.h);
    const w = Math.max(1, Math.round(e.doc.w * s)),
      h = Math.max(1, Math.round(e.doc.h * s));
    c.width = w;
    c.height = h;
    const g = c.getContext('2d')!;
    drawChecker(g, w, h);
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, x * s, y * s, src.width * s, src.height * s);
  }, [src, x, y, e.doc.w, e.doc.h]);
  if (layer.kind === 'group')
    return (
      <span className="ph-thumb icon">
        {layer.open ? <FolderOpen size={18} /> : <Folder size={18} />}
      </span>
    );
  if (layer.kind === 'adjust')
    return (
      <span className="ph-thumb icon" title={ADJ_LABELS[layer.adj.type]}>
        <SlidersHorizontal size={16} />
      </span>
    );
  return <canvas ref={ref} className="ph-thumb" />;
}

function MaskThumb({ e, mask }: { e: Engine; mask: Mask }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const S = 34;
    const s = Math.min(S / e.doc.w, S / e.doc.h);
    c.width = Math.max(1, Math.round(e.doc.w * s));
    c.height = Math.max(1, Math.round(e.doc.h * s));
    const g = c.getContext('2d')!;
    g.fillStyle = mask.outside >= 128 ? '#fff' : '#000';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(mask.canvas, mask.x * s, mask.y * s, mask.canvas.width * s, mask.canvas.height * s);
  }, [mask.canvas, mask.x, mask.y, mask.outside, e.doc.w, e.doc.h]);
  return <canvas ref={ref} className="ph-thumb" style={{ opacity: mask.enabled ? 1 : 0.4 }} />;
}

// ---------- Layers ----------
export function LayersPanel({ e }: { e: Engine }) {
  const rows = e.flat();
  const active = e.active;
  const [renaming, setRenaming] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; where: 'above' | 'below' | 'into' } | null>(null);
  const dragId = useRef<string | null>(null);
  const [opDraft, setOpDraft] = useState<{ key: 'opacity' | 'fill'; v: number } | null>(null);

  const setProp = (patch: Partial<Layer>, label: string) => active && act(() => ops.setLayer(e, active.id, patch as any, label));
  // Opacity/fill sliders preview live and record one step when released.
  const live = (key: 'opacity' | 'fill', v: number) => {
    if (!active) return;
    (active as any)[key] = v / 100;
    setOpDraft({ key, v });
    e.invalidate();
  };
  const commitLive = () => {
    if (!active || !opDraft) return;
    setOpDraft(null);
    e.commit(opDraft.key === 'opacity' ? 'Layer opacity' : 'Layer fill');
  };

  return (
    <div className="ph-layers">
      {active && (
        <div className="ph-layer-props">
          <select className="select ph-select" value={active.blend} onChange={(ev) => setProp({ blend: ev.target.value as LayerBlend }, 'Blend mode')} title="Blend mode">
            {active.kind === 'group' && <option value="pass-through">Pass through</option>}
            {BLEND_MODES.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
          <button className={`icon-btn sm ${active.locked ? 'active' : ''}`} title={active.locked ? 'Unlock layer' : 'Lock layer'} onClick={() => setProp({ locked: !active.locked }, active.locked ? 'Unlock layer' : 'Lock layer')}>
            {active.locked ? <Lock size={15} /> : <LockOpen size={15} />}
          </button>
          <div className="ph-mini-slider" title="Opacity">
            <span>Opacity</span>
            <input type="range" min={0} max={100} value={Math.round(active.opacity * 100)} onChange={(ev) => live('opacity', +ev.target.value)} onPointerUp={commitLive} onKeyUp={commitLive} />
            <span className="ph-unit">{Math.round(active.opacity * 100)}%</span>
          </div>
          {active.kind !== 'group' && (
            <div className="ph-mini-slider" title="Fill (the layer's own pixels)">
              <span>Fill</span>
              <input type="range" min={0} max={100} value={Math.round(active.fill * 100)} onChange={(ev) => live('fill', +ev.target.value)} onPointerUp={commitLive} onKeyUp={commitLive} />
              <span className="ph-unit">{Math.round(active.fill * 100)}%</span>
            </div>
          )}
        </div>
      )}
      <div className="ph-layer-list" onDragLeave={() => setDrop(null)}>
        {rows.length === 0 && <div className="empty-note">No layers. Add one below.</div>}
        {rows.map(({ layer, depth, hiddenByParent }) => {
          const on = layer.id === active?.id;
          return (
            <div
              key={layer.id}
              className={`ph-layer ${on ? 'on' : ''} ${hiddenByParent ? 'dim' : ''} ${drop?.id === layer.id ? 'drop-' + drop.where : ''}`}
              style={{ paddingLeft: 4 + depth * 16 }}
              draggable={renaming !== layer.id}
              onDragStart={(ev) => {
                dragId.current = layer.id;
                ev.dataTransfer.effectAllowed = 'move';
                ev.dataTransfer.setData('text/plain', layer.id);
              }}
              onDragOver={(ev) => {
                if (!dragId.current) return;
                ev.preventDefault();
                const r = ev.currentTarget.getBoundingClientRect();
                const f = (ev.clientY - r.top) / r.height;
                const where = layer.kind === 'group' && f > 0.3 && f < 0.7 ? 'into' : f < 0.5 ? 'above' : 'below';
                setDrop({ id: layer.id, where });
              }}
              onDrop={(ev) => {
                ev.preventDefault();
                const id = dragId.current;
                dragId.current = null;
                setDrop(null);
                if (id && drop) act(() => ops.moveLayer(e, id, drop.id, drop.where));
              }}
              onDragEnd={() => {
                dragId.current = null;
                setDrop(null);
              }}
              onClick={() => {
                if (e.textEditing) return;
                e.editTarget = 'pixels';
                e.setActive(layer.id);
              }}
            >
              <button
                className="ph-eye"
                title={layer.visible ? 'Hide' : 'Show'}
                onClick={(ev) => {
                  ev.stopPropagation();
                  act(() => ops.setLayer(e, layer.id, { visible: !layer.visible }, layer.visible ? 'Hide layer' : 'Show layer'));
                }}
              >
                {layer.visible ? <Eye size={15} /> : <EyeOff size={15} />}
              </button>
              {layer.kind === 'group' && (
                <button
                  className="ph-eye"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    layer.open = !layer.open;
                    e.emit();
                  }}
                >
                  {layer.open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              )}
              {layer.clip && <CornerLeftDown size={13} className="ph-clip" />}
              <span
                className={`ph-thumb-wrap ${on && e.editTarget === 'pixels' ? 'target' : ''}`}
                title={isPixelLayer(layer) ? 'Ctrl+click to select its pixels' : undefined}
                onClick={(ev) => {
                  if ((ev.ctrlKey || ev.metaKey) && isPixelLayer(layer)) {
                    ev.stopPropagation();
                    act(() => ops.selectLayerPixels(e, layer.id));
                  }
                }}
              >
                {layer.kind === 'text' ? (
                  <span className="ph-thumb icon">
                    <Type size={16} />
                  </span>
                ) : layer.kind === 'shape' ? (
                  <span className="ph-thumb icon">
                    <Shapes size={16} />
                  </span>
                ) : (
                  <Thumb e={e} layer={layer} />
                )}
              </span>
              {layer.mask && (
                <span
                  className={`ph-thumb-wrap ${on && e.editTarget === 'mask' ? 'target' : ''}`}
                  title="Layer mask: click to paint on it, Shift+click to turn it off/on"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    if (ev.shiftKey) {
                      e.setActive(layer.id);
                      return act(() => ops.toggleMask(e));
                    }
                    e.editTarget = 'mask';
                    e.setActive(layer.id);
                  }}
                >
                  <MaskThumb e={e} mask={layer.mask} />
                </span>
              )}
              {renaming === layer.id ? (
                <input
                  className="input sm ph-rename"
                  autoFocus
                  defaultValue={layer.name}
                  onClick={(ev) => ev.stopPropagation()}
                  onKeyDown={(ev) => {
                    ev.stopPropagation();
                    if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
                    if (ev.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={(ev) => {
                    const v = ev.target.value.trim();
                    setRenaming(null);
                    if (v && v !== layer.name) act(() => ops.setLayer(e, layer.id, { name: v }, 'Rename layer'));
                  }}
                />
              ) : (
                <span
                  className="ph-layer-name"
                  onDoubleClick={(ev) => {
                    ev.stopPropagation();
                    setRenaming(layer.id);
                  }}
                  title="Double-click to rename"
                >
                  {layer.name}
                </span>
              )}
              {layer.locked && <Lock size={12} className="ph-lock" />}
            </div>
          );
        })}
      </div>
      <div className="ph-layer-bar">
        <button className="icon-btn sm" title="New layer (Ctrl+Shift+N)" onClick={() => act(() => ops.addLayer(e))}>
          <Plus size={16} />
        </button>
        <button className="icon-btn sm" title="New group" onClick={() => act(() => ops.addGroup(e))}>
          <FolderPlus size={16} />
        </button>
        <MenuButton
          title="Add a layer mask"
          button={() => (
            <button className="icon-btn sm" disabled={!active || !!active.mask}>
              <SquareDashed size={16} />
            </button>
          )}
        >
          {(close) => (
            <>
              <button className="menu-item" onClick={() => (act(() => ops.addMask(e, 'reveal')), close())}>
                Reveal all (white)
              </button>
              <button className="menu-item" onClick={() => (act(() => ops.addMask(e, 'hide')), close())}>
                Hide all (black)
              </button>
              <button className="menu-item" disabled={!e.selection} onClick={() => (act(() => ops.addMask(e, 'selection')), close())}>
                From selection
              </button>
            </>
          )}
        </MenuButton>
        <MenuButton
          title="New adjustment layer"
          button={() => (
            <button className="icon-btn sm">
              <SlidersHorizontal size={16} />
            </button>
          )}
        >
          {(close) => (
            <div className="ph-menu-scroll">
              {ADJ_ORDER.map((t) => (
                <button key={t} className="menu-item" onClick={() => (act(() => ops.addAdjustmentLayer(e, adjDefaults(t))), close())}>
                  {ADJ_LABELS[t]}
                </button>
              ))}
            </div>
          )}
        </MenuButton>
        <button className="icon-btn sm" title="Clip to the layer below (Ctrl+Alt+G)" disabled={!active} onClick={() => act(() => ops.toggleClip(e))}>
          <CornerLeftDown size={16} />
        </button>
        <button className="icon-btn sm" title="Merge down (Ctrl+E)" disabled={!active} onClick={() => act(() => ops.mergeDown(e))}>
          <Merge size={16} />
        </button>
        <button className="icon-btn sm" title="Duplicate layer (Ctrl+J)" disabled={!active} onClick={() => act(() => ops.duplicateLayer(e))}>
          <Copy size={16} />
        </button>
        <span className="tb-spacer" />
        <button className="icon-btn sm" title="Delete layer" disabled={!active} onClick={() => act(() => ops.deleteLayer(e))}>
          <Trash2 size={16} />
        </button>
      </div>
    </div>
  );
}

// ---------- Properties ----------
export function PropertiesPanel({ e }: { e: Engine }) {
  const l = e.active;
  if (!l)
    return (
      <div className="ph-props">
        <p className="ph-hint">
          Image: {e.doc.w} × {e.doc.h} px
        </p>
      </div>
    );
  return (
    <div className="ph-props">
      {l.kind === 'adjust' && <AdjustProps e={e} layerId={l.id} key={l.id} />}
      {l.kind === 'text' && <TextProps e={e} />}
      {l.kind === 'shape' && <ShapeProps e={e} />}
      {isPixelLayer(l) && (
        <p className="ph-hint">
          {l.kind === 'raster' ? 'Pixel layer' : l.kind === 'text' ? 'Text layer' : 'Shape layer'} · {l.canvas.width} × {l.canvas.height} px at ({l.x}, {l.y})
        </p>
      )}
      {l.kind === 'group' && <p className="ph-hint">Group with {l.children.length} layer{l.children.length === 1 ? '' : 's'}. Pass through lets its layers blend with what's below.</p>}
      {(l.kind === 'text' || l.kind === 'shape') && (
        <button className="btn sm" onClick={() => act(() => ops.rasterizeActive(e))}>
          Rasterize
        </button>
      )}
      {l.mask && <MaskProps e={e} />}
    </div>
  );
}

function AdjustProps({ e, layerId }: { e: Engine; layerId: string }) {
  const f = e.find(layerId);
  const l = f?.layer;
  const timer = useRef(0);
  const hist = useMemo(() => {
    const c = e.flush();
    return histogram(getPixels(c).data, Math.max(1, Math.floor((c.width * c.height) / 300000)));
  }, [layerId]);
  const flush = () => {
    timer.current = 0;
    const p = e.adjPreview;
    if (!p) return;
    const t = e.find(p.layerId)?.layer;
    e.adjPreview = null;
    if (t && t.kind === 'adjust') {
      t.adj = p.adj;
      e.commit(`Edit ${ADJ_LABELS[t.adj.type]}`);
    }
  };
  useEffect(
    () => () => {
      // Leaving the panel mid-edit: keep what was set.
      if (timer.current) {
        clearTimeout(timer.current);
        flush();
      }
    },
    []
  );
  if (!l || l.kind !== 'adjust') return null;
  const adj = e.adjOf(l);
  return (
    <>
      <div className="ph-props-title">{ADJ_LABELS[adj.type]}</div>
      <AdjustmentControls
        adj={adj}
        hist={hist}
        onChange={(a) => {
          e.adjPreview = { layerId: l.id, adj: a };
          e.invalidate();
          e.emit();
          clearTimeout(timer.current);
          timer.current = window.setTimeout(flush, 500);
        }}
        onCommit={() => {
          clearTimeout(timer.current);
          flush();
        }}
      />
      <button
        className="btn sm"
        onClick={() => {
          e.adjPreview = null;
          l.adj = adjDefaults(l.adj.type);
          e.commit(`Reset ${ADJ_LABELS[l.adj.type]}`);
        }}
      >
        Reset to defaults
      </button>
    </>
  );
}

function TextProps({ e }: { e: Engine }) {
  const l = e.active;
  if (!l || l.kind !== 'text') return null;
  const t = l.text;
  const set = (patch: Partial<typeof t>, commit = true) => {
    l.text = { ...l.text, ...patch };
    renderText(l);
    e.invalidate();
    if (commit && !e.textEditing) e.commit('Text settings');
    else e.emit();
  };
  return (
    <>
      <div className="ph-props-title">Text</div>
      <Field label="Font">
        <select className="select ph-select" value={t.font} onChange={(ev) => set({ font: ev.target.value })}>
          {(FONTS.includes(t.font) ? FONTS : [t.font, ...FONTS]).map((f) => (
            <option key={f} value={f} style={{ fontFamily: f }}>
              {f}
            </option>
          ))}
        </select>
      </Field>
      <Slider label="Size" value={t.size} min={4} max={500} unit="px" onChange={(v) => set({ size: v }, false)} onCommit={() => set({}, true)} />
      <Slider label="Line height" value={t.leading} min={0.6} max={3} step={0.05} onChange={(v) => set({ leading: v }, false)} onCommit={() => set({}, true)} />
      <Field label="Colour">
        <ColorInput value={t.color} onChange={(c) => set({ color: c })} />
      </Field>
      <div className="ph-row">
        <Check label="Bold" checked={t.bold} onChange={(b) => set({ bold: b })} />
        <Check label="Italic" checked={t.italic} onChange={(b) => set({ italic: b })} />
      </div>
      <Seg
        value={t.align}
        options={[
          { id: 'left', label: 'Left' },
          { id: 'center', label: 'Center' },
          { id: 'right', label: 'Right' }
        ]}
        onChange={(a) => set({ align: a })}
      />
      <p className="ph-hint">Use the Text tool (T) and click the text to change the words.</p>
    </>
  );
}

function ShapeProps({ e }: { e: Engine }) {
  const l = e.active;
  if (!l || l.kind !== 'shape') return null;
  const s = l.shape;
  const set = (patch: Partial<typeof s>, commit = true) => {
    l.shape = { ...l.shape, ...patch };
    renderShape(l);
    e.invalidate();
    if (commit) e.commit('Shape settings');
    else e.emit();
  };
  return (
    <>
      <div className="ph-props-title">Shape</div>
      {s.type !== 'line' && (
        <div className="ph-row">
          <Check label="Fill" checked={!!s.fill} onChange={(b) => set({ fill: b ? e.fg : null })} />
          {s.fill && <ColorInput value={s.fill} onChange={(c) => set({ fill: c })} />}
        </div>
      )}
      <div className="ph-row">
        <Check label={s.type === 'line' ? 'Colour' : 'Stroke'} checked={!!s.stroke} onChange={(b) => set({ stroke: b ? e.fg : null })} />
        {s.stroke && <ColorInput value={s.stroke} onChange={(c) => set({ stroke: c })} />}
      </div>
      <Slider label={s.type === 'line' ? 'Weight' : 'Stroke width'} value={s.strokeWidth} min={0} max={200} unit="px" onChange={(v) => set({ strokeWidth: v }, false)} onCommit={() => set({}, true)} />
      {s.type === 'rect' && <Slider label="Corner radius" value={s.radius} min={0} max={500} unit="px" onChange={(v) => set({ radius: v }, false)} onCommit={() => set({}, true)} />}
      {s.type === 'polygon' && <Slider label="Sides" value={s.sides} min={3} max={24} onChange={(v) => set({ sides: v }, false)} onCommit={() => set({}, true)} />}
    </>
  );
}

function MaskProps({ e }: { e: Engine }) {
  const l = e.active!;
  const m = l.mask!;
  return (
    <>
      <div className="ph-props-title">Layer mask</div>
      <div className="ph-row">
        <Check label="Mask on" checked={m.enabled} onChange={() => act(() => ops.toggleMask(e))} />
        <button
          className={`icon-btn sm ${m.linked ? 'active' : ''}`}
          title={m.linked ? 'Mask moves with the layer (click to unlink)' : 'Mask stays put when the layer moves (click to link)'}
          onClick={() => {
            m.linked = !m.linked;
            e.commit(m.linked ? 'Link mask' : 'Unlink mask');
          }}
        >
          {m.linked ? <Link2 size={15} /> : <Unlink2 size={15} />}
        </button>
      </div>
      <div className="ph-chips">
        <button
          className="btn tonal sm"
          onClick={() => {
            const c = cloneCanvas(m.canvas);
            const g = c.getContext('2d')!;
            g.globalCompositeOperation = 'difference';
            g.fillStyle = '#fff';
            g.fillRect(0, 0, c.width, c.height);
            m.canvas = c;
            m.outside = 255 - m.outside;
            e.commit('Invert mask');
          }}
        >
          Invert
        </button>
        {isPixelLayer(l) && (
          <button className="btn tonal sm" onClick={() => act(() => ops.deleteMask(e, true))}>
            Apply
          </button>
        )}
        <button className="btn tonal sm" onClick={() => act(() => ops.deleteMask(e, false))}>
          Delete
        </button>
      </div>
      <p className="ph-hint">{e.editTarget === 'mask' ? 'Painting on the mask: black hides, white shows.' : 'Click the mask thumbnail to paint on it.'}</p>
    </>
  );
}

// ---------- Adjustments ----------
export function AdjustmentsPanel({ e }: { e: Engine }) {
  return (
    <div className="ph-adj-grid">
      {ADJ_ORDER.map((t: AdjType) => (
        <button key={t} className="ph-adj-btn" title={`New ${ADJ_LABELS[t]} adjustment layer`} onClick={() => act(() => ops.addAdjustmentLayer(e, adjDefaults(t)))}>
          {ADJ_LABELS[t]}
        </button>
      ))}
    </div>
  );
}

// ---------- History ----------
export function HistoryPanel({ e }: { e: Engine }) {
  const ref = useRef<HTMLDivElement>(null);
  const h = e.history;
  useEffect(() => {
    ref.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }, [h.index, h.entries.length]);
  return (
    <div className="ph-history" ref={ref}>
      {h.entries.map((en, i) => (
        <button key={i} className={`ph-hist-row ${i === h.index ? 'on' : ''} ${i > h.index ? 'future' : ''}`} onClick={() => e.jumpTo(i)}>
          {en.label}
        </button>
      ))}
    </div>
  );
}

