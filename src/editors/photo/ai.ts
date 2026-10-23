import type { AiHooks, AssistantTool } from '../../store';
import type { Engine } from './engine';
import type { AdjType, FilterType, Layer, LayerBlend, TextData } from './types';
import { BLEND_MODES } from './types';
import { ADJ_LABELS, ADJ_ORDER, adjDefaults } from './adjustments';
import { FILTER_LABELS, filterDefaults } from './filters';
import { TOOL_NAMES } from './toolOptions';
import { downscale } from './canvas';
import { textBox } from './vector';
import * as ops from './ops';
import { removeBackground, selectSubject } from './segment';

/**
 * What the Assistant sidebar sees and can do in the photo editor: a text description
 * of the document, a picture of it, and tools that each make one undoable change.
 */

const FILTER_TYPES = Object.keys(FILTER_LABELS) as FilterType[];
const BLEND_IDS = BLEND_MODES.map((b) => b.id);

function describeLayer(e: Engine, l: Layer, depth: number): string[] {
  const pad = '  '.repeat(depth);
  const bits = [`${Math.round(l.opacity * 100)}% opacity`, `blend ${l.blend}`];
  if (l.fill < 1) bits.push(`fill ${Math.round(l.fill * 100)}%`);
  if (!l.visible) bits.push('hidden');
  if (l.locked) bits.push('locked');
  if (l.clip) bits.push('clipped to layer below');
  if (l.mask) bits.push(`has a layer mask${l.mask.enabled ? '' : ' (off)'}`);
  if (l.id === e.state.activeId) bits.push('ACTIVE');
  let kind: string;
  if (l.kind === 'raster') kind = `pixels ${l.canvas.width}×${l.canvas.height} at (${l.x}, ${l.y})`;
  else if (l.kind === 'text') {
    const b = textBox(l.text);
    kind = `text "${l.text.text.slice(0, 80)}" ${Math.round(l.text.size)}px ${l.text.font} ${l.text.color}, box (${Math.round(b.x)}, ${Math.round(b.y)}) ${Math.round(b.w)}×${Math.round(b.h)}`;
  } else if (l.kind === 'shape') kind = `${l.shape.type} shape (${Math.round(l.shape.x1)}, ${Math.round(l.shape.y1)})–(${Math.round(l.shape.x2)}, ${Math.round(l.shape.y2)})`;
  else if (l.kind === 'adjust') kind = `${ADJ_LABELS[l.adj.type]} adjustment layer ${JSON.stringify(stripType(l.adj))}`;
  else kind = 'group';
  const lines = [`${pad}- "${l.name}" [${kind}] ${bits.join(', ')}`];
  if (l.kind === 'group') for (let i = l.children.length - 1; i >= 0; i--) lines.push(...describeLayer(e, l.children[i], depth + 1));
  return lines;
}
const stripType = (a: any) => {
  const { type: _t, ...rest } = a;
  return rest;
};

function describe(e: Engine): string {
  const lines = [`Image: ${e.doc.w} × ${e.doc.h} px. Coordinates are pixels from the top-left corner.`, `Active tool: ${TOOL_NAMES[e.tool]}. Foreground colour ${e.fg}, background ${e.bg}.`];
  lines.push(e.selection ? `Selection: bounds x=${e.selection.bounds.x}, y=${e.selection.bounds.y}, ${e.selection.bounds.w}×${e.selection.bounds.h}. Filters, adjustments (destructive), fill and delete only affect the selection.` : 'Selection: none (whole layer is affected).');
  lines.push(`Layers, top to bottom (${e.allLayers().length}):`);
  for (let i = e.doc.layers.length - 1; i >= 0; i--) lines.push(...describeLayer(e, e.doc.layers[i], 0));
  const h = e.history;
  lines.push(`History: ${h.index + 1} steps, last "${h.entries[h.index]?.label}".`);
  return lines.join('\n');
}

/** Find a layer by id, exact name, or name ignoring case; defaults to the active layer. */
function findLayer(e: Engine, ref?: string): Layer {
  if (!ref) {
    const a = e.active;
    if (!a) throw new Error('There is no active layer');
    return a;
  }
  const all = e.allLayers();
  const hit = all.find((l) => l.id === ref) || all.find((l) => l.name === ref) || all.find((l) => l.name.toLowerCase() === ref.toLowerCase());
  if (!hit) throw new Error(`No layer named "${ref}". Layers: ${all.map((l) => `"${l.name}"`).join(', ')}`);
  return hit;
}

/** Merge settings into defaults one level deep (so `{ rgb: { midtoneInput: 1.2 } }` keeps the other levels values). */
function merge(base: any, over: any) {
  if (!over || typeof over !== 'object') return base;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    if (k === 'type') continue;
    const b = base[k],
      o = over[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) && o && typeof o === 'object' && !Array.isArray(o) ? { ...b, ...o } : o;
  }
  return out;
}

const color = { type: 'string', description: 'CSS hex colour like "#ff8800"' };
const layerRef = { type: 'string', description: 'Layer name (or id). Leave out to use the active layer.' };

/** Run a change as exactly one history step: nothing changed means nothing recorded; extra steps are folded. */
async function oneStep(e: Engine, fn: () => Promise<string> | string): Promise<string> {
  const before = e.history.index;
  const msg = await fn();
  const added = e.history.index - before;
  if (added > 1) {
    // Fold the extra steps into the last one so a single undo reverts the whole action.
    const last = e.history.entries[e.history.index];
    e.history.entries.splice(before + 1, added, last);
    e.history.index = before + 1;
    e.emit();
  }
  return msg;
}

export function photoAi(e: Engine): AiHooks {
  const tools: AssistantTool[] = [
    {
      name: 'apply_adjustment',
      description:
        'Colour/tone adjustment. By default adds a non-destructive adjustment layer above the active layer (masked to the selection if there is one). ' +
        'Settings (all optional, merged into neutral defaults): brightness {brightness -150..150, contrast -50..100}; ' +
        'levels {rgb|red|green|blue: {shadowInput 0-255, midtoneInput gamma 0.1-9.99 (1 neutral, >1 brighter), highlightInput 0-255, shadowOutput, highlightOutput}}; ' +
        'curves {rgb|red|green|blue: [{input 0-255, output 0-255}, …] including the end points}; exposure {exposure -5..5 stops, offset -0.5..0.5, gamma 0.1..3}; ' +
        'vibrance {vibrance -100..100, saturation -100..100}; hueSat {hue -180..180, saturation -100..100, lightness -100..100, colorize bool, colorHue 0-360, colorSat 0-100}; ' +
        'colorBalance {shadows|midtones|highlights: {cyanRed, magentaGreen, yellowBlue each -100..100}, preserveLuminosity}; bw {reds, yellows, greens, cyans, blues, magentas -200..300, useTint, tintColor}; ' +
        'photoFilter {color, density 0-100, preserveLuminosity}; channelMixer {monochrome, red|green|blue|gray: {red, green, blue, constant} percentages}; invert {}; posterize {levels 2-255}; threshold {level 1-255}; ' +
        'gradientMap {stops: [{pos 0-1, color}], reverse}; selectiveColor {mode relative|absolute, reds|yellows|greens|cyans|blues|magentas|whites|neutrals|blacks: {c, m, y, k} -100..100}.',
      input_schema: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ADJ_ORDER },
          settings: { type: 'object', description: 'Adjustment settings as described above.' },
          destructive: { type: 'boolean', description: 'true = change the active layer’s pixels directly instead of adding an adjustment layer.' }
        },
        required: ['type']
      },
      run: (i) =>
        oneStep(e, async () => {
          const type = i.type as AdjType;
          if (!ADJ_ORDER.includes(type)) throw new Error(`Unknown adjustment "${i.type}"`);
          const adj = merge(adjDefaults(type), i.settings);
          adj.type = type;
          if (i.destructive) return ops.applyAdjustmentPixels(e, adj);
          const l = ops.addAdjustmentLayer(e, adj);
          return `Added a ${ADJ_LABELS[type]} adjustment layer "${l.name}"${l.mask ? ' masked to the selection' : ''}`;
        })
    },
    {
      name: 'apply_filter',
      description:
        'Filter the active layer’s pixels (only inside the selection if there is one). Text/shape layers are rasterized first. Settings (optional): ' +
        'gaussian {radius px}; box {radius}; motion {angle deg, distance px}; radial {mode zoom|spin, amount 1-100, cx 0-1, cy 0-1}; unsharp {amount %, radius px, threshold 0-255}; ' +
        'sharpen {amount 1-200}; noise {amount 0-100, gaussian bool, mono bool}; median {radius 1-20}; pixelate {size px}; emboss {angle, height 1-10, amount %}; edges {}; ' +
        'oil {radius 1-20}; vignette {amount -100 (dark) .. 100 (light), midpoint 0-100, feather 0-100, roundness 0-100}; offset {dx, dy, edge wrap|repeat|transparent}.',
      input_schema: {
        type: 'object',
        properties: { type: { type: 'string', enum: FILTER_TYPES }, settings: { type: 'object' } },
        required: ['type']
      },
      run: (i) =>
        oneStep(e, () => {
          const type = i.type as FilterType;
          if (!FILTER_TYPES.includes(type)) throw new Error(`Unknown filter "${i.type}"`);
          return ops.applyFilter(e, { ...filterDefaults(type), ...(i.settings || {}), type });
        })
    },
    {
      name: 'select_rect',
      description: 'Select a rectangle (or ellipse) in image pixels. mode: new (default), add, subtract, intersect.',
      input_schema: {
        type: 'object',
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          ellipse: { type: 'boolean' },
          mode: { type: 'string', enum: ['new', 'add', 'subtract', 'intersect'] }
        },
        required: ['x', 'y', 'width', 'height']
      },
      run: (i) => oneStep(e, () => ops.selectRect(e, { x: i.x, y: i.y, w: i.width, h: i.height }, i.mode || 'new', !!i.ellipse))
    },
    { name: 'select_all', description: 'Select the whole image.', input_schema: { type: 'object', properties: {} }, run: () => oneStep(e, () => ops.selectAll(e)) },
    { name: 'select_none', description: 'Remove the selection.', input_schema: { type: 'object', properties: {} }, run: () => oneStep(e, () => ops.deselect(e)) },
    { name: 'invert_selection', description: 'Select everything that is not selected now.', input_schema: { type: 'object', properties: {} }, run: () => oneStep(e, () => ops.invertSelection(e)) },
    {
      name: 'remove_background',
      description: 'Remove the background from the active layer with an on-device AI model (needs a background-removal model downloaded in Settings → AI image tools). output: "erase" wipes the background pixels (default), "mask" hides it non-destructively as a layer mask, "selection" just selects the subject.',
      input_schema: { type: 'object', properties: { output: { type: 'string', enum: ['erase', 'mask', 'selection'] } } },
      run: (i) => oneStep(e, () => removeBackground(e, i.output || 'erase'))
    },
    { name: 'select_subject', description: 'Select the main subject of the active layer with an on-device AI model (needs a background-removal model in Settings → AI image tools).', input_schema: { type: 'object', properties: {} }, run: () => oneStep(e, () => selectSubject(e)) },
    {
      name: 'select_color_range',
      description: 'Select every pixel close to a colour in the whole picture. fuzziness 1-255 (default 60).',
      input_schema: { type: 'object', properties: { color, fuzziness: { type: 'number' }, mode: { type: 'string', enum: ['new', 'add', 'subtract', 'intersect'] } }, required: ['color'] },
      run: (i) => oneStep(e, () => ops.colorRange(e, i.color, i.fuzziness ?? 60, i.mode || 'new'))
    },
    {
      name: 'add_layer',
      description: 'Add an empty pixel layer above the active one and make it active.',
      input_schema: { type: 'object', properties: { name: { type: 'string' } } },
      run: (i) => oneStep(e, () => ops.addLayer(e, i.name))
    },
    {
      name: 'set_active_layer',
      description: 'Make a layer the active one (later edits apply to it).',
      input_schema: { type: 'object', properties: { layer: layerRef }, required: ['layer'] },
      run: (i) => {
        const l = findLayer(e, i.layer);
        e.editTarget = 'pixels';
        e.setActive(l.id);
        return `"${l.name}" is now active`;
      }
    },
    {
      name: 'set_layer',
      description: 'Change a layer’s name, opacity (0-100), fill (0-100), blend mode, visibility or lock.',
      input_schema: {
        type: 'object',
        properties: {
          layer: layerRef,
          name: { type: 'string' },
          opacity: { type: 'number' },
          fill: { type: 'number' },
          blend: { type: 'string', enum: [...BLEND_IDS, 'pass-through'] },
          visible: { type: 'boolean' },
          locked: { type: 'boolean' }
        }
      },
      run: (i) =>
        oneStep(e, () => {
          const l = findLayer(e, i.layer);
          const patch: Partial<Layer> = {};
          if (typeof i.name === 'string') patch.name = i.name;
          if (typeof i.opacity === 'number') patch.opacity = Math.max(0, Math.min(100, i.opacity)) / 100;
          if (typeof i.fill === 'number') patch.fill = Math.max(0, Math.min(100, i.fill)) / 100;
          if (i.blend) patch.blend = i.blend as LayerBlend;
          if (typeof i.visible === 'boolean') patch.visible = i.visible;
          if (typeof i.locked === 'boolean') patch.locked = i.locked;
          return ops.setLayer(e, l.id, patch as any);
        })
    },
    {
      name: 'delete_layer',
      description: 'Delete a layer.',
      input_schema: { type: 'object', properties: { layer: layerRef } },
      run: (i) => oneStep(e, () => ops.deleteLayer(e, findLayer(e, i.layer).id))
    },
    {
      name: 'duplicate_layer',
      description: 'Duplicate the active layer (or the named one).',
      input_schema: { type: 'object', properties: { layer: layerRef } },
      run: (i) =>
        oneStep(e, () => {
          e.state.activeId = findLayer(e, i.layer).id;
          return ops.duplicateLayer(e);
        })
    },
    {
      name: 'add_layer_mask',
      description: 'Add a mask to the active layer: from the selection (default when something is selected), reveal all, or hide all.',
      input_schema: { type: 'object', properties: { mode: { type: 'string', enum: ['selection', 'reveal', 'hide'] } } },
      run: (i) => oneStep(e, () => ops.addMask(e, i.mode || (e.selection ? 'selection' : 'reveal')))
    },
    {
      name: 'fill',
      description: 'Fill the selection (or the whole active layer if nothing is selected) with a colour.',
      input_schema: { type: 'object', properties: { color, opacity: { type: 'number', description: '0-100, default 100' } }, required: ['color'] },
      run: (i) => oneStep(e, () => ops.fill(e, i.color, (i.opacity ?? 100) / 100))
    },
    {
      name: 'add_text',
      description: 'Add an editable text layer. x/y is the top-left of the text (top-centre for align center, top-right for align right).',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Use \\n for new lines' },
          x: { type: 'number' },
          y: { type: 'number' },
          size: { type: 'number', description: 'Font size in px (default 48)' },
          color,
          font: { type: 'string', description: 'Font family, e.g. Inter, Arial, Georgia, Impact' },
          bold: { type: 'boolean' },
          italic: { type: 'boolean' },
          align: { type: 'string', enum: ['left', 'center', 'right'] }
        },
        required: ['text', 'x', 'y']
      },
      run: (i) =>
        oneStep(e, () => {
          const o = e.opts.text;
          const t: TextData = { text: String(i.text), font: i.font || o.font, size: i.size || o.size, color: i.color || e.fg, bold: !!i.bold, italic: !!i.italic, align: i.align || 'left', leading: o.leading, x: i.x, y: i.y };
          const l = ops.addTextLayer(e, t);
          e.commit('New text');
          return `Added text layer "${l.name}"`;
        })
    },
    {
      name: 'add_shape',
      description: 'Add an editable shape layer: rect, ellipse, polygon (with sides) or line (from x,y to x+width,y+height).',
      input_schema: {
        type: 'object',
        properties: {
          shape: { type: 'string', enum: ['rect', 'ellipse', 'polygon', 'line'] },
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          fill: { type: 'string', description: 'Hex colour, or "none"' },
          stroke: { type: 'string', description: 'Hex colour, or "none"' },
          strokeWidth: { type: 'number' },
          cornerRadius: { type: 'number' },
          sides: { type: 'number' }
        },
        required: ['shape', 'x', 'y', 'width', 'height']
      },
      run: (i) =>
        oneStep(e, () => {
          const none = (v: any) => !v || v === 'none';
          const line = i.shape === 'line';
          const l = ops.addShapeLayer(e, {
            type: i.shape,
            x1: i.x,
            y1: i.y,
            x2: i.x + i.width,
            y2: i.y + i.height,
            sides: i.sides || 6,
            radius: i.cornerRadius || 0,
            fill: line ? null : none(i.fill) ? (i.fill === 'none' ? null : e.fg) : i.fill,
            stroke: line ? (!none(i.stroke) ? i.stroke : !none(i.fill) ? i.fill : e.fg) : none(i.stroke) ? null : i.stroke,
            strokeWidth: i.strokeWidth ?? 4
          });
          e.commit('New shape');
          return `Added ${i.shape} layer "${l.name}"`;
        })
    },
    {
      name: 'crop',
      description: 'Crop the image to a rectangle (image pixels).',
      input_schema: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } }, required: ['x', 'y', 'width', 'height'] },
      run: (i) => oneStep(e, () => ops.cropTo(e, { x: i.x, y: i.y, w: i.width, h: i.height }))
    },
    {
      name: 'resize_image',
      description: 'Resample the whole image to a new size. Give width and/or height; a missing one keeps the proportions.',
      input_schema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' } } },
      run: (i) =>
        oneStep(e, () => {
          const r = e.doc.w / e.doc.h;
          const w = i.width || Math.round(i.height * r);
          const h = i.height || Math.round(i.width / r);
          if (!w || !h) throw new Error('Give a width or a height');
          return ops.resizeImage(e, w, h);
        })
    },
    {
      name: 'canvas_size',
      description: 'Change the canvas size without resampling (adds or trims space). anchor: center (default), top-left, top, top-right, left, right, bottom-left, bottom, bottom-right.',
      input_schema: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' }, anchor: { type: 'string' }, fill: { type: 'string', description: 'Colour for new space, or omit for transparent' } }, required: ['width', 'height'] },
      run: (i) =>
        oneStep(e, () => {
          const a = String(i.anchor || 'center');
          const ax = a.includes('left') ? 0 : a.includes('right') ? 1 : 0.5;
          const ay = a.includes('top') ? 0 : a.includes('bottom') ? 1 : 0.5;
          return ops.canvasSize(e, i.width, i.height, { ax, ay } as ops.Anchor, i.fill || null);
        })
    },
    {
      name: 'rotate',
      description: 'Rotate the whole image clockwise by degrees (90/180/270 are lossless; other angles grow the canvas).',
      input_schema: { type: 'object', properties: { degrees: { type: 'number' } }, required: ['degrees'] },
      run: (i) => oneStep(e, () => ops.rotateImage(e, i.degrees))
    },
    {
      name: 'flip',
      description: 'Flip the whole image or just the active layer.',
      input_schema: { type: 'object', properties: { direction: { type: 'string', enum: ['horizontal', 'vertical'] }, target: { type: 'string', enum: ['image', 'layer'] } }, required: ['direction'] },
      run: (i) => oneStep(e, () => (i.target === 'layer' ? ops.flipLayer(e, i.direction === 'vertical' ? 'v' : 'h') : ops.flipImage(e, i.direction === 'vertical' ? 'v' : 'h')))
    },
    {
      name: 'merge_or_flatten',
      description: 'merge_down: merge the active layer into the one below; merge_visible; flatten: everything into one layer on white.',
      input_schema: { type: 'object', properties: { action: { type: 'string', enum: ['merge_down', 'merge_visible', 'flatten'] } }, required: ['action'] },
      run: (i) => oneStep(e, () => (i.action === 'merge_down' ? ops.mergeDown(e) : i.action === 'merge_visible' ? ops.mergeVisible(e) : ops.flatten(e)))
    },
    {
      name: 'undo',
      description: 'Undo the last change(s).',
      input_schema: { type: 'object', properties: { steps: { type: 'number', description: 'How many steps (default 1)' } } },
      run: (i) => {
        const n = Math.max(1, Math.min(50, Math.round(i.steps || 1)));
        const target = Math.max(0, e.history.index - n);
        const undone = e.history.entries.slice(target + 1, e.history.index + 1).map((x) => x.label);
        if (!undone.length) return 'Nothing to undo';
        e.jumpTo(target);
        return `Undid: ${undone.reverse().join(', ')}`;
      }
    }
  ];

  return {
    noun: 'image',
    async getDocument() {
      const full = describe(e);
      return { full, sections: [{ id: 'image', label: 'Image', text: full }] };
    },
    async getImage() {
      const c = downscale(e.flush(), 1568);
      // Show transparency as a light checker-free white so Claude sees the picture clearly.
      const out = document.createElement('canvas');
      out.width = c.width;
      out.height = c.height;
      const g = out.getContext('2d')!;
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, out.width, out.height);
      g.drawImage(c, 0, 0);
      const scaled = c.width !== e.doc.w;
      return {
        dataUrl: out.toDataURL('image/png'),
        width: e.doc.w,
        height: e.doc.h,
        note: `Flattened composite${scaled ? `, scaled down to ${c.width}×${c.height} (multiply coordinates by ${(e.doc.w / c.width).toFixed(3)} for image pixels)` : ''}; transparent areas shown white.`
      };
    },
    tools
  };
}
