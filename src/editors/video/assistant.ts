import type { AssistantTool, DocSection } from '../../store';
import type { Store } from './state';
import type { Player } from './player';
import type { Project, Clip, MediaItem, Track, AnimProp, Ease, TransitionType, BlendMode, TextAnim, Colour } from './model';
import {
  ANIMATABLE,
  ASPECTS,
  BLEND_MODES,
  COLOUR_PRESETS,
  EASES,
  NEUTRAL_COLOUR,
  DEFAULT_PROPS,
  TEXT_ANIMS,
  TRANSITIONS,
  TRANSITION_DIRS,
  aspectOf,
  clipDuration,
  clipEnd,
  mediaOf,
  projectDuration,
  setKey,
  shortTime,
  snapToFrame,
  timecode,
  trackClips
} from './model';
import { splitAt, deleteClips, trimStart, trimEnd, rippleTrim, setTransition, defaultTransition, clipsForMedia, overwrite, insert, textClip, shapeClip, addTrack, withLinked, clearRange, isStill } from './ops';
import { renderStill } from './exporter';
import { uid } from '../../lib/util';
import { resolveImage } from '../../lib/attachments';
import { api } from '../../lib/api';

/* Claude's view of the video project (text + a frame) and the actions it may take. */

export interface AssistantEnv {
  store: Store;
  player: Player;
  /** Import files by absolute path into the media bin; returns the new media items (throws with a plain message on failure). */
  importPaths(paths: string[]): Promise<MediaItem[]>;
}

/* ---------- Describing the project ---------- */

const n2 = (v: number) => (Math.round(v * 100) / 100).toString();
const sec = (t: number, fps: number) => `${n2(t)} s (${timecode(t, fps)})`;

function describeClip(p: Project, c: Clip): string[] {
  const fps = p.settings.fps;
  const m = mediaOf(p, c);
  const kind = c.kind === 'media' ? m?.kind ?? 'media' : c.kind;
  const lines = [`- clip ${c.id} "${c.name}" [${kind}] ${n2(c.start)}–${n2(clipEnd(c))} s (${timecode(c.start, fps)}–${timecode(clipEnd(c), fps)})`];
  const d: string[] = [];
  if (c.kind === 'media' && m && m.kind !== 'image') d.push(`source ${n2(c.in)}–${n2(c.out)} s of ${m.name}`);
  if (c.ramp?.length) d.push(`speed ramp ${c.ramp.map((k) => `${n2(k.t)}s:${n2(k.v)}×`).join(' → ')}`);
  else if (c.speed !== 1 || c.reverse) d.push(`speed ${c.speed}×${c.reverse ? ' reversed' : ''}${c.speed !== 1 ? (c.keepPitch ? ' (pitch kept)' : ' (pitch changes)') : ''}`);
  if (c.linkId) d.push(`linked (${c.linkId})`);
  const props = c.props as unknown as Record<string, number | boolean>;
  const def = DEFAULT_PROPS as unknown as Record<string, number | boolean>;
  const changed = Object.keys(def).filter((k) => props[k] !== def[k] && !(c.kf as any)[k]?.length);
  if (changed.length) d.push(changed.map((k) => `${k} ${props[k]}`).join(', '));
  if (lines.length) lines[0] += d.length ? ` · ${d.join(' · ')}` : '';
  const extra: string[] = [];
  for (const k of ANIMATABLE) {
    const keys = c.kf[k];
    if (keys?.length) extra.push(`${k} keyframes: ${keys.map((x) => `${n2(c.start + x.t)} s=${n2(x.v)}${x.ease !== 'linear' ? ` (${x.ease})` : ''}`).join(', ')}`);
  }
  const col = (Object.keys(NEUTRAL_COLOUR) as (keyof Colour)[]).filter((k) => c.colour[k] !== 0);
  if (col.length) extra.push(`colour: ${col.map((k) => `${k} ${c.colour[k]}`).join(', ')}`);
  if (c.key.enabled) extra.push(`chroma key ${c.key.color}, tolerance ${c.key.tolerance}, softness ${c.key.softness}, spill ${c.key.spill}`);
  const cr = c.crop;
  if (cr.left || cr.right || cr.top || cr.bottom) extra.push(`crop left ${cr.left}% right ${cr.right}% top ${cr.top}% bottom ${cr.bottom}%`);
  if (c.blend !== 'normal') extra.push(`blend ${c.blend}`);
  if (c.trIn) extra.push(`transition in: ${c.trIn.type}${c.trIn.dir ? ' ' + c.trIn.dir : ''} ${n2(c.trIn.duration)} s`);
  if (c.trOut) extra.push(`transition out: ${c.trOut.type}${c.trOut.dir ? ' ' + c.trOut.dir : ''} ${n2(c.trOut.duration)} s`);
  if (c.freeze !== undefined) extra.push(`freeze frame at source ${n2(c.freeze)} s`);
  if (c.text) {
    const t = c.text;
    extra.push(`text "${t.text.replace(/\n/g, '\\n')}" · ${t.font} ${t.size}px ${t.color}${t.bold ? ' bold' : ''}${t.italic ? ' italic' : ''} ${t.align}${t.box ? ` · box ${t.box}` : ''}${t.outline && t.outlineWidth ? ` · outline ${t.outline} ${t.outlineWidth}px` : ''} · animation in ${t.animIn}, out ${t.animOut}`);
  }
  if (c.shape) extra.push(`shape ${c.shape.shape} fill ${c.shape.fill}${c.shape.shape !== 'matte' ? ` ${c.shape.w}×${c.shape.h}` : ''}`);
  return [...lines, ...extra.map((x) => `    ${x}`)];
}

function trackText(p: Project, t: Track) {
  const flags = [t.muted && 'muted', t.solo && 'solo', t.locked && 'locked', t.hidden && 'hidden', t.volume !== 0 && `volume ${t.volume} dB`].filter(Boolean);
  const clips = trackClips(p, t.id);
  const head = `Track ${t.name} (${t.kind}${flags.length ? `, ${flags.join(', ')}` : ''}) — ${clips.length} clip${clips.length === 1 ? '' : 's'}`;
  return [head, ...clips.flatMap((c) => describeClip(p, c))].join('\n');
}

function projectText(store: Store) {
  const s = store.getState();
  const p = s.project;
  const st = p.settings;
  const lines = [
    'Kea video project. Times are in seconds on the timeline; tools take clip ids, track names (V1 = bottom picture layer; higher V tracks draw on top) and media ids.',
    `Settings: ${st.width}×${st.height} (${st.aspect}), ${st.fps} fps, background ${st.background}`,
    `Duration ${sec(projectDuration(p), st.fps)} · playhead ${sec(s.playhead, st.fps)}`,
    `Timeline in/out: ${p.inPoint !== null ? n2(p.inPoint) : 'none'} / ${p.outPoint !== null ? n2(p.outPoint) : 'none'}`,
    'Media bin:',
    ...(p.media.length
      ? p.media.map((m) => `- media ${m.id} "${m.name}" [${m.kind}]${m.kind !== 'image' ? ` ${n2(m.duration)} s` : ''}${m.width ? ` ${m.width}×${m.height}` : ''}${m.hasAudio && m.kind === 'video' ? ' with sound' : ''} · ${m.path || '(in memory only)'}`)
      : ['(empty)'])
  ];
  return lines.join('\n');
}

function markersText(p: Project) {
  if (!p.markers.length) return 'Markers: none';
  return ['Markers:', ...[...p.markers].sort((a, b) => a.t - b.t).map((m) => `- marker ${m.id} at ${sec(m.t, p.settings.fps)} "${m.name}" ${m.color}`)].join('\n');
}

export function projectSections(store: Store): DocSection[] {
  const p = store.getState().project;
  return [
    { id: 'project', label: 'Project', text: projectText(store) },
    ...p.tracks.map((t) => ({ id: t.id, label: `Track ${t.name}`, text: trackText(p, t) })),
    { id: 'markers', label: 'Markers', text: markersText(p) }
  ];
}

export function describeProject(store: Store): string {
  return projectSections(store)
    .map((x) => x.text)
    .join('\n\n');
}

/** The program frame at the playhead as a PNG (long side ≤ 1568 px). */
export async function snapshot(store: Store): Promise<{ dataUrl: string; width: number; height: number; note: string } | null> {
  const s = store.getState();
  const p = s.project;
  const { width: W, height: H, fps } = p.settings;
  const k = Math.min(1, 1568 / Math.max(W, H));
  try {
    const canvas = await renderStill(p, s.playhead, W * k, H * k);
    return {
      dataUrl: canvas.toDataURL('image/png'),
      width: canvas.width,
      height: canvas.height,
      note: `Program monitor at ${timecode(s.playhead, fps)} (${n2(s.playhead)} s) of ${shortTime(projectDuration(p))}, ${W}×${H}`
    };
  } catch (err) {
    console.warn('video snapshot failed', err);
    return null;
  }
}

/* ---------- Tools ---------- */

function findClip(p: Project, id: string): Clip {
  const c = p.clips.find((x) => x.id === id);
  if (!c) throw new Error(`There's no clip with id ${id}.`);
  return c;
}
function findTrack(p: Project, name: string): Track {
  const t = p.tracks.find((x) => x.name.toLowerCase() === String(name).trim().toLowerCase());
  if (!t) throw new Error(`There's no track called ${name}. Tracks: ${p.tracks.map((x) => x.name).join(', ')}.`);
  return t;
}
function trackById(p: Project, id: string) {
  return p.tracks.find((t) => t.id === id)!;
}
function assertUnlocked(p: Project, c: Clip) {
  const t = trackById(p, c.trackId);
  if (t?.locked) throw new Error(`Track ${t.name} is locked.`);
}
function num(v: unknown, what: string): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error(`${what} must be a number.`);
  return n;
}
function bool(v: unknown) {
  return v === true || v === 'true' || v === 1 || v === 'on' || v === 'yes';
}
const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Run one undoable edit and return its message. */
function edit(store: Store, label: string, fn: (p: Project) => string): string {
  let msg = '';
  store.getState().commit(label, (p) => {
    msg = fn(p);
  });
  return msg;
}

const NUM_PROPS: Record<string, { anim?: AnimProp; lo: number; hi: number; set?: (c: Clip, v: number) => void }> = {
  opacity: { anim: 'opacity', lo: 0, hi: 100 },
  scale: { anim: 'scale', lo: 1, hi: 2000 },
  x: { anim: 'x', lo: -20000, hi: 20000 },
  y: { anim: 'y', lo: -20000, hi: 20000 },
  rotation: { anim: 'rotation', lo: -3600, hi: 3600 },
  blur: { anim: 'blur', lo: 0, hi: 200 },
  volume: { anim: 'volume', lo: -60, hi: 12 },
  gain: { lo: -40, hi: 40, set: (c, v) => (c.props.gain = v) },
  fade_in: { lo: 0, hi: 600, set: (c, v) => (c.props.fadeIn = v) },
  fade_out: { lo: 0, hi: 600, set: (c, v) => (c.props.fadeOut = v) },
  pan: { lo: -100, hi: 100, set: (c, v) => (c.props.pan = v) },
  crop_left: { lo: 0, hi: 99, set: (c, v) => (c.crop.left = v) },
  crop_right: { lo: 0, hi: 99, set: (c, v) => (c.crop.right = v) },
  crop_top: { lo: 0, hi: 99, set: (c, v) => (c.crop.top = v) },
  crop_bottom: { lo: 0, hi: 99, set: (c, v) => (c.crop.bottom = v) },
  exposure: { lo: -3, hi: 3, set: (c, v) => (c.colour.exposure = v) },
  contrast: { lo: -100, hi: 100, set: (c, v) => (c.colour.contrast = v) },
  saturation: { lo: -100, hi: 100, set: (c, v) => (c.colour.saturation = v) },
  temperature: { lo: -100, hi: 100, set: (c, v) => (c.colour.temperature = v) },
  tint: { lo: -100, hi: 100, set: (c, v) => (c.colour.tint = v) },
  highlights: { lo: -100, hi: 100, set: (c, v) => (c.colour.highlights = v) },
  shadows: { lo: -100, hi: 100, set: (c, v) => (c.colour.shadows = v) },
  vignette: { lo: 0, hi: 100, set: (c, v) => (c.colour.vignette = v) },
  chroma_tolerance: { lo: 0, hi: 100, set: (c, v) => (c.key.tolerance = v) },
  chroma_softness: { lo: 0, hi: 100, set: (c, v) => (c.key.softness = v) },
  outline_width: { lo: 0, hi: 100, set: (c, v) => (needText(c).outlineWidth = v) },
  font_size: { lo: 4, hi: 1000, set: (c, v) => (needText(c).size = v) }
};
const OTHER_PROPS = ['speed', 'reverse', 'keep_pitch', 'flip_h', 'flip_v', 'blend', 'colour_preset', 'chroma_key', 'chroma_key_color', 'name', 'text', 'font', 'text_color', 'bold', 'italic', 'align', 'box_color', 'outline_color', 'shadow_color', 'anim_in', 'anim_out', 'shape_fill'];
const ALL_PROPS = [...Object.keys(NUM_PROPS), ...OTHER_PROPS];

function needText(c: Clip) {
  if (!c.text) throw new Error(`Clip ${c.id} isn't a text clip.`);
  return c.text;
}
function needAnim(v: unknown): TextAnim {
  const a = TEXT_ANIMS.find((x) => x.id === v);
  if (!a) throw new Error(`Animation must be one of: ${TEXT_ANIMS.map((x) => x.id).join(', ')}.`);
  return a.id;
}

/** Change speed keeping the in point; the clip may not run into the next clip on its track. */
function applySpeed(p: Project, c: Clip, speed: number) {
  const next = trackClips(p, c.trackId).find((x) => x.id !== c.id && x.start >= clipEnd(c) - 1e-6);
  c.speed = speed;
  c.ramp = undefined; // a constant speed replaces any ramp
  if (isStill(p, c)) return;
  if (next && clipEnd(c) > next.start) {
    const len = next.start - c.start;
    if (c.reverse) c.in = c.out - len * speed;
    else c.out = c.in + len * speed;
  }
}

export function videoTools(env: AssistantEnv): AssistantTool[] {
  const { store } = env;
  const fpsOf = () => store.getState().project.settings.fps;
  const snap = (t: number) => Math.max(0, snapToFrame(t, fpsOf()));

  return [
    {
      name: 'add_media_to_timeline',
      description:
        'Put a piece of media on the timeline: from the media bin (media_id), a file (absolute path, imported first), an image the student attached in the chat (attachment), or a graphic you draw as SVG (svg: title cards, lower-third plates, backgrounds, diagrams, overlays with transparency; draw it at the project’s frame size, read design_guide "video" and the vector topics first). Video with sound adds a linked picture clip and audio clip.',
      input_schema: {
        type: 'object',
        properties: {
          media_id: { type: 'string', description: 'Id of an item in the media bin.' },
          path: { type: 'string', description: 'Absolute path of a video, audio or image file to import and add.' },
          attachment: { type: 'string', description: 'Id of an image the student attached in the chat, like "a1".' },
          svg: { type: 'string', description: 'A graphic you write as a complete <svg viewBox="0 0 W H">…</svg>, W × H = the frame size (e.g. 1920 × 1080). Transparent areas stay transparent over the clips below.' },
          start: { type: 'number', description: 'Timeline time in seconds. Default: the playhead (or the end of the timeline with append).' },
          append: { type: 'boolean', description: 'Place it at the end of the timeline.' },
          in: { type: 'number', description: 'Source in point (seconds into the file). Default 0.' },
          out: { type: 'number', description: 'Source out point (seconds). Default: the end of the file (images: 5 s long).' },
          track: { type: 'string', description: 'Track name for the picture (e.g. "V2"); audio goes on a free audio track.' },
          mode: { type: 'string', enum: ['overwrite', 'insert'], description: 'overwrite replaces what is underneath; insert pushes later clips right. Default overwrite.' }
        }
      },
      async run(i) {
        let m: MediaItem | undefined;
        if (i.svg || i.attachment) {
          // Graphics and attached pictures become real image files (Documents/Kea Graphics) so the project keeps them.
          const img = await resolveImage({ svg: i.svg, attachment: i.attachment });
          const docs = (await api.knownFolders()).find((f) => f.id === 'documents')?.path;
          if (!docs) throw new Error('Kea couldn’t find your Documents folder to keep the graphic in.');
          const file = `${docs}${docs.includes('\\') ? '\\' : '/'}Kea Graphics${docs.includes('\\') ? '\\' : '/'}${(i.svg ? 'graphic' : img.name.replace(/\.[^.]+$/, '')).replace(/[^\w -]+/g, '').slice(0, 40) || 'image'}-${Date.now().toString(36)}.png`;
          const b64 = img.dataUrl.startsWith('data:image/png') ? img.dataUrl : await (async () => {
            const c = document.createElement('canvas');
            c.width = img.img.naturalWidth || img.width;
            c.height = img.img.naturalHeight || img.height;
            c.getContext('2d')!.drawImage(img.img, 0, 0);
            return c.toDataURL('image/png');
          })();
          const bin = atob(b64.slice(b64.indexOf(',') + 1));
          const bytes = new Uint8Array(bin.length);
          for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
          if (!(await api.writeFile(file, bytes))) throw new Error('The graphic couldn’t be saved.');
          m = (await env.importPaths([file]))[0];
        } else if (i.path) m = (await env.importPaths([String(i.path)]))[0];
        else if (i.media_id) m = store.getState().project.media.find((x) => x.id === i.media_id);
        if (!m) throw new Error(i.media_id ? `There's no media with id ${i.media_id}.` : 'Give media_id, path, attachment or svg.');
        const media = m;
        return edit(store, 'Add to timeline', (p) => {
          const at = snap(i.start !== undefined ? num(i.start, 'start') : i.append ? projectDuration(p) : store.getState().playhead);
          let vTrack: string | undefined;
          if (i.track) {
            const t = findTrack(p, i.track);
            if (t.locked) throw new Error(`Track ${t.name} is locked.`);
            vTrack = t.id;
          }
          const a = i.in !== undefined ? clampN(num(i.in, 'in'), 0, media.duration || Infinity) : undefined;
          const b = i.out !== undefined ? num(i.out, 'out') : undefined;
          if (a !== undefined && b !== undefined && b <= a) throw new Error('out must be after in.');
          const clips = clipsForMedia(p, media, at, { vTrack: media.kind === 'audio' ? undefined : vTrack, aTrack: media.kind === 'audio' ? vTrack : undefined, in: a, out: b, findFree: !vTrack });
          if (i.mode === 'insert') insert(p, clips);
          else overwrite(p, clips);
          return `Added ${media.name} at ${n2(at)} s (${clips.map((c) => `${trackById(p, c.trackId).name}: ${c.id}`).join(', ')})`;
        });
      }
    },
    {
      name: 'split_at',
      description: 'Cut clips in two at a timeline time (like the razor). Without clip_ids or track, cuts every clip on unlocked tracks under that time.',
      input_schema: {
        type: 'object',
        properties: {
          time: { type: 'number', description: 'Timeline time in seconds.' },
          track: { type: 'string', description: 'Only cut clips on this track (e.g. "V1").' },
          clip_ids: { type: 'array', items: { type: 'string' }, description: 'Only cut these clips (and their linked partners).' }
        },
        required: ['time']
      },
      run(i) {
        return edit(store, 'Split', (p) => {
          const t = snap(num(i.time, 'time'));
          let ids: string[] | undefined = i.clip_ids;
          if (ids) ids.forEach((id) => findClip(p, id));
          if (i.track) {
            const tr = findTrack(p, i.track);
            if (tr.locked) throw new Error(`Track ${tr.name} is locked.`);
            ids = p.clips.filter((c) => c.trackId === tr.id && c.start < t && clipEnd(c) > t).map((c) => c.id);
            if (!ids.length) throw new Error(`Nothing on ${tr.name} at ${n2(t)} s.`);
          }
          const made = splitAt(p, t, ids);
          if (!made.length) throw new Error(`No clip to split at ${n2(t)} s.`);
          return `Split ${made.length} clip${made.length === 1 ? '' : 's'} at ${n2(t)} s; new right-hand clips: ${made.map((c) => c.id).join(', ')}`;
        });
      }
    },
    {
      name: 'delete_clip',
      description: 'Remove clips. With ripple, later clips on the same tracks slide left to close the gap.',
      input_schema: {
        type: 'object',
        properties: {
          clip_ids: { type: 'array', items: { type: 'string' } },
          ripple: { type: 'boolean', description: 'Close the gap left behind. Default false.' },
          include_linked: { type: 'boolean', description: 'Also remove linked picture/sound partners. Default true.' }
        },
        required: ['clip_ids']
      },
      run(i) {
        return edit(store, i.ripple ? 'Ripple delete' : 'Delete', (p) => {
          const ids: string[] = i.clip_ids || [];
          if (!ids.length) throw new Error('Give at least one clip id.');
          ids.forEach((id) => assertUnlocked(p, findClip(p, id)));
          let count: number;
          if (i.include_linked === false) {
            // Unlink first so only the named clips go.
            for (const id of ids) findClip(p, id).linkId = undefined;
          }
          count = deleteClips(p, ids, !!i.ripple);
          return `Deleted ${count} clip${count === 1 ? '' : 's'}${i.ripple ? ' and closed the gap' : ''}`;
        });
      }
    },
    {
      name: 'move_clip',
      description: 'Move a clip (and its linked partners) to a new start time and optionally another track of the same kind. Overwrites whatever is where it lands.',
      input_schema: {
        type: 'object',
        properties: {
          clip_id: { type: 'string' },
          start: { type: 'number', description: 'New timeline start in seconds.' },
          track: { type: 'string', description: 'Destination track name (same kind: video clips to V tracks, audio to A tracks).' }
        },
        required: ['clip_id', 'start']
      },
      run(i) {
        return edit(store, 'Move clip', (p) => {
          const c = findClip(p, i.clip_id);
          assertUnlocked(p, c);
          const d = snap(num(i.start, 'start')) - c.start;
          const group = withLinked(p, [c.id]).map((id) => findClip(p, id));
          group.forEach((g) => assertUnlocked(p, g));
          if (group.some((g) => g.start + d < -1e-6)) throw new Error("Clips can't start before 0 s.");
          if (i.track) {
            const t = findTrack(p, i.track);
            const cur = trackById(p, c.trackId);
            if (t.kind !== cur.kind) throw new Error(`${c.name} can only go on ${cur.kind} tracks.`);
            if (t.locked) throw new Error(`Track ${t.name} is locked.`);
            c.trackId = t.id;
          }
          for (const g of group) g.start = Math.max(0, g.start + d);
          const keep = new Set(group.map((g) => g.id));
          for (const g of group) clearRange(p, g.trackId, g.start, clipEnd(g), keep);
          return `Moved ${c.name} to ${n2(c.start)} s on ${trackById(p, c.trackId).name}${group.length > 1 ? ` (with ${group.length - 1} linked clip${group.length > 2 ? 's' : ''})` : ''}`;
        });
      }
    },
    {
      name: 'trim_clip',
      description: "Move a clip's start and/or end edge to new timeline times (trimming or extending into spare source). With ripple, later clips on the same tracks move to close or open the gap. Linked partners are trimmed too.",
      input_schema: {
        type: 'object',
        properties: {
          clip_id: { type: 'string' },
          start: { type: 'number', description: 'New start edge, timeline seconds.' },
          end: { type: 'number', description: 'New end edge, timeline seconds.' },
          ripple: { type: 'boolean', description: 'Ripple trim. Default false.' }
        },
        required: ['clip_id']
      },
      run(i) {
        return edit(store, i.ripple ? 'Ripple trim' : 'Trim', (p) => {
          const c = findClip(p, i.clip_id);
          assertUnlocked(p, c);
          if (i.start === undefined && i.end === undefined) throw new Error('Give a new start or end.');
          const group = withLinked(p, [c.id]).map((id) => findClip(p, id)).filter((g) => g !== c);
          if (i.end !== undefined) {
            const d = snap(num(i.end, 'end')) - clipEnd(c);
            if (i.ripple) rippleTrim(p, c, 'end', d);
            else {
              const real = trimEnd(p, c, d);
              for (const g of group) trimEnd(p, g, real);
            }
          }
          if (i.start !== undefined) {
            const d = snap(num(i.start, 'start')) - c.start;
            if (i.ripple) rippleTrim(p, c, 'start', d);
            else {
              const real = trimStart(p, c, d);
              for (const g of group) trimStart(p, g, real);
            }
          }
          return `${c.name} now runs ${n2(c.start)}–${n2(clipEnd(c))} s (source ${n2(c.in)}–${n2(c.out)} s)`;
        });
      }
    },
    {
      name: 'set_clip_property',
      description:
        'Change one setting of a clip. Numbers: opacity 0–100, scale % (100 = fit frame), x/y offset from centre in project pixels, rotation degrees, blur px, volume dB (-60..12), gain dB, fade_in/fade_out seconds, pan -100..100, speed 0.25–4, crop_* percent, exposure stops (-3..3), contrast/saturation/temperature/tint/highlights/shadows -100..100, vignette 0–100, chroma_tolerance/softness 0–100, font_size px, outline_width px. Booleans: reverse, keep_pitch, flip_h, flip_v, chroma_key, bold, italic. Strings: blend, colour_preset, chroma_key_color/text_color/box_color/outline_color/shadow_color/shape_fill (hex, "" for none), name, text, font, align (left/center/right), anim_in/anim_out. Animatable props (opacity, scale, x, y, rotation, blur, volume) set a keyframe when at_time is given or the property is already keyframed.',
      input_schema: {
        type: 'object',
        properties: {
          clip_id: { type: 'string' },
          property: { type: 'string', enum: ALL_PROPS },
          value: { type: ['string', 'number', 'boolean'], description: 'New value.' },
          at_time: { type: 'number', description: 'Timeline time for a keyframe (animatable properties only).' }
        },
        required: ['clip_id', 'property', 'value']
      },
      run(i) {
        return edit(store, 'Change clip', (p) => {
          const c = findClip(p, i.clip_id);
          assertUnlocked(p, c);
          const prop = String(i.property);
          const v = i.value;
          const nd = NUM_PROPS[prop];
          if (nd) {
            const val = clampN(num(v, prop), nd.lo, nd.hi);
            if (nd.anim) {
              const keyed = !!c.kf[nd.anim]?.length;
              if (i.at_time !== undefined || keyed) {
                const t = i.at_time !== undefined ? snap(num(i.at_time, 'at_time')) : store.getState().playhead;
                if (t < c.start - 1e-6 || t > clipEnd(c) + 1e-6) throw new Error(`${n2(t)} s is outside the clip (${n2(c.start)}–${n2(clipEnd(c))} s).`);
                if (!keyed) c.kf[nd.anim] = [{ t: 0, v: c.props[nd.anim], ease: 'linear' as Ease }].filter(() => t - c.start > 1e-3);
                setKey(c, nd.anim, t - c.start, val);
                return `Set a ${prop} keyframe of ${val} at ${n2(t)} s on ${c.name}`;
              }
              (c.props as any)[nd.anim] = val;
            } else nd.set!(c, val);
            return `Set ${prop} of ${c.name} to ${val}`;
          }
          const partnersOf = () => withLinked(p, [c.id]).map((id) => findClip(p, id));
          switch (prop) {
            case 'speed': {
              const sp = clampN(num(v, 'speed'), 0.25, 4);
              if (isStill(p, c)) throw new Error("Stills, text and shapes don't have a speed; trim them to change their length.");
              for (const g of partnersOf()) applySpeed(p, g, sp);
              return `${c.name} now plays at ${sp}× (${n2(clipDuration(c))} s long)`;
            }
            case 'reverse':
              for (const g of partnersOf()) g.reverse = bool(v);
              return `${c.name} ${bool(v) ? 'now plays backwards' : 'plays forwards'}`;
            case 'keep_pitch':
              for (const g of partnersOf()) g.keepPitch = bool(v);
              return `Pitch ${bool(v) ? 'kept' : 'follows speed'} on ${c.name}`;
            case 'flip_h':
              c.props.flipH = bool(v);
              break;
            case 'flip_v':
              c.props.flipV = bool(v);
              break;
            case 'blend':
              if (!BLEND_MODES.includes(v as BlendMode)) throw new Error(`Blend must be one of: ${BLEND_MODES.join(', ')}.`);
              c.blend = v as BlendMode;
              break;
            case 'colour_preset': {
              const pr = COLOUR_PRESETS.find((x) => x.id === v || x.label.toLowerCase() === String(v).toLowerCase());
              if (!pr) throw new Error(`Preset must be one of: ${COLOUR_PRESETS.map((x) => x.id).join(', ')}.`);
              c.colour = { ...NEUTRAL_COLOUR, ...pr.c };
              return `Applied the ${pr.label} look to ${c.name}`;
            }
            case 'chroma_key':
              c.key.enabled = bool(v);
              break;
            case 'chroma_key_color':
              c.key.color = String(v);
              c.key.enabled = true;
              break;
            case 'name':
              c.name = String(v);
              break;
            case 'text':
              needText(c).text = String(v);
              c.name = String(v).split('\n')[0].slice(0, 40) || 'Text';
              break;
            case 'font':
              needText(c).font = String(v);
              break;
            case 'text_color':
              needText(c).color = String(v);
              break;
            case 'bold':
              needText(c).bold = bool(v);
              break;
            case 'italic':
              needText(c).italic = bool(v);
              break;
            case 'align':
              if (!['left', 'center', 'right'].includes(String(v))) throw new Error('Align must be left, center or right.');
              needText(c).align = v as 'left' | 'center' | 'right';
              break;
            case 'box_color':
              needText(c).box = String(v);
              break;
            case 'outline_color':
              needText(c).outline = String(v);
              if (v && !c.text!.outlineWidth) c.text!.outlineWidth = 4;
              break;
            case 'shadow_color':
              needText(c).shadow = String(v);
              break;
            case 'anim_in':
              needText(c).animIn = needAnim(v);
              break;
            case 'anim_out':
              needText(c).animOut = needAnim(v);
              break;
            case 'shape_fill':
              if (!c.shape) throw new Error(`Clip ${c.id} isn't a shape or colour matte.`);
              c.shape.fill = String(v);
              break;
            default:
              throw new Error(`Unknown property ${prop}.`);
          }
          return `Set ${prop} of ${c.name} to ${String(v)}`;
        });
      }
    },
    {
      name: 'add_keyframes',
      description: "Animate a property with keyframes (replaces that property's existing animation). Use for moves, zooms (Ken Burns), fades of opacity, volume ducking.",
      input_schema: {
        type: 'object',
        properties: {
          clip_id: { type: 'string' },
          property: { type: 'string', enum: [...ANIMATABLE], description: 'opacity 0–100, scale %, x/y px from centre, rotation degrees, blur px, volume dB.' },
          keyframes: {
            type: 'array',
            description: 'Timeline times (seconds) and values. Empty array removes the animation.',
            items: {
              type: 'object',
              properties: { time: { type: 'number' }, value: { type: 'number' }, ease: { type: 'string', enum: EASES.map((e) => e.id), description: 'How it moves to the next keyframe.' } },
              required: ['time', 'value']
            }
          }
        },
        required: ['clip_id', 'property', 'keyframes']
      },
      run(i) {
        return edit(store, 'Keyframes', (p) => {
          const c = findClip(p, i.clip_id);
          assertUnlocked(p, c);
          const prop = i.property as AnimProp;
          if (!ANIMATABLE.includes(prop)) throw new Error(`Only ${ANIMATABLE.join(', ')} can be animated.`);
          const keys = (i.keyframes || []).map((k: any) => {
            const t = snap(num(k.time, 'time'));
            if (t < c.start - 1e-6 || t > clipEnd(c) + 1e-6) throw new Error(`Keyframe at ${n2(t)} s is outside the clip (${n2(c.start)}–${n2(clipEnd(c))} s).`);
            const ease = (EASES.find((e) => e.id === k.ease)?.id || 'linear') as Ease;
            return { t: t - c.start, v: num(k.value, 'value'), ease };
          });
          keys.sort((a: { t: number }, b: { t: number }) => a.t - b.t);
          if (keys.length) c.kf[prop] = keys;
          else {
            delete c.kf[prop];
            return `Removed the ${prop} animation from ${c.name}`;
          }
          return `Animated ${prop} on ${c.name} with ${keys.length} keyframe${keys.length === 1 ? '' : 's'}`;
        });
      }
    },
    {
      name: 'add_transition',
      description: "Add a transition at a clip's start (edge 'in') or end (edge 'out'). At a cut between two touching clips it blends them; at a free edge it fades from/to nothing. On audio clips, dissolve is a crossfade.",
      input_schema: {
        type: 'object',
        properties: {
          clip_id: { type: 'string' },
          edge: { type: 'string', enum: ['in', 'out'] },
          type: { type: 'string', enum: TRANSITIONS.map((t) => t.id), description: TRANSITIONS.map((t) => `${t.id}: ${t.hint}`).join(' ') },
          duration: { type: 'number', description: 'Seconds. Default 1 for dissolve, 0.6 for others.' },
          direction: { type: 'string', enum: TRANSITION_DIRS, description: 'Which way wipe / slide / cover / whip move (left = the new shot enters from the right).' }
        },
        required: ['clip_id', 'edge', 'type']
      },
      run(i) {
        return edit(store, 'Add transition', (p) => {
          const c = findClip(p, i.clip_id);
          assertUnlocked(p, c);
          const type = TRANSITIONS.find((t) => t.id === i.type)?.id as TransitionType | undefined;
          if (!type) throw new Error(`Transition must be one of: ${TRANSITIONS.map((t) => t.id).join(', ')}.`);
          if (i.edge !== 'in' && i.edge !== 'out') throw new Error("edge must be 'in' or 'out'.");
          const tr = defaultTransition(type);
          if (i.duration !== undefined) tr.duration = Math.max(1 / 30, num(i.duration, 'duration'));
          if (i.direction && TRANSITION_DIRS.includes(i.direction)) tr.dir = i.direction;
          const ref = setTransition(p, c.id, i.edge, tr);
          if (!ref) throw new Error('Could not add the transition.');
          const at = findClip(p, ref.clipId);
          const real = (ref.edge === 'in' ? at.trIn : at.trOut)!.duration;
          return `Added ${TRANSITIONS.find((t) => t.id === type)!.label} (${n2(real)} s) at the ${ref.edge === 'in' ? 'start' : 'end'} of ${at.name}`;
        });
      }
    },
    {
      name: 'remove_transition',
      description: "Remove the transition at a clip's start or end.",
      input_schema: { type: 'object', properties: { clip_id: { type: 'string' }, edge: { type: 'string', enum: ['in', 'out'] } }, required: ['clip_id', 'edge'] },
      run(i) {
        return edit(store, 'Remove transition', (p) => {
          const c = findClip(p, i.clip_id);
          assertUnlocked(p, c);
          const had = i.edge === 'in' ? !!c.trIn : !!c.trOut;
          setTransition(p, c.id, i.edge, null);
          return had || i.edge === 'out' ? `Removed the transition at the ${i.edge === 'in' ? 'start' : 'end'} of ${c.name}` : `${c.name} had no transition there`;
        });
      }
    },
    {
      name: 'add_text',
      description: 'Add a title / caption text clip on a free video track (above other picture).',
      input_schema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Use \\n for new lines.' },
          start: { type: 'number', description: 'Timeline seconds. Default: the playhead.' },
          duration: { type: 'number', description: 'Seconds. Default 3.' },
          x: { type: 'number', description: 'Offset from the frame centre in project pixels (negative = left).' },
          y: { type: 'number', description: 'Offset from the frame centre in project pixels (positive = down). E.g. a lower third is about 0.35 × frame height.' },
          track: { type: 'string', description: 'Video track name. Default: the top free one.' },
          style: {
            type: 'object',
            properties: {
              font: { type: 'string' },
              size: { type: 'number', description: 'Pixels at project resolution (default 96).' },
              color: { type: 'string' },
              bold: { type: 'boolean' },
              italic: { type: 'boolean' },
              align: { type: 'string', enum: ['left', 'center', 'right'] },
              box: { type: 'string', description: 'Background box colour, "" for none.' },
              outline: { type: 'string', description: 'Outline colour.' },
              outline_width: { type: 'number' },
              anim_in: { type: 'string', enum: TEXT_ANIMS.map((a) => a.id) },
              anim_out: { type: 'string', enum: TEXT_ANIMS.map((a) => a.id) }
            }
          }
        },
        required: ['text']
      },
      run(i) {
        return edit(store, 'Add text', (p) => {
          const at = snap(i.start !== undefined ? num(i.start, 'start') : store.getState().playhead);
          const len = Math.max(0.1, i.duration !== undefined ? num(i.duration, 'duration') : 3);
          const s = i.style || {};
          const style: Record<string, unknown> = { text: String(i.text ?? '') };
          if (s.font) style.font = s.font;
          if (s.size !== undefined) style.size = clampN(num(s.size, 'size'), 4, 1000);
          if (s.color) style.color = s.color;
          if (s.bold !== undefined) style.bold = bool(s.bold);
          if (s.italic !== undefined) style.italic = bool(s.italic);
          if (s.align) style.align = s.align;
          if (s.box !== undefined) style.box = s.box;
          if (s.outline !== undefined) {
            style.outline = s.outline;
            style.outlineWidth = s.outline_width !== undefined ? num(s.outline_width, 'outline_width') : 4;
          }
          if (s.anim_in) style.animIn = needAnim(s.anim_in);
          if (s.anim_out) style.animOut = needAnim(s.anim_out);
          let trackId: string | undefined;
          if (i.track) {
            const t = findTrack(p, i.track);
            if (t.kind !== 'video') throw new Error('Text goes on a video track.');
            if (t.locked) throw new Error(`Track ${t.name} is locked.`);
            trackId = t.id;
          }
          const c = textClip(p, at, len, style, trackId);
          if (i.x !== undefined) c.props.x = num(i.x, 'x');
          if (i.y !== undefined) c.props.y = num(i.y, 'y');
          overwrite(p, [c]);
          return `Added text clip ${c.id} on ${trackById(p, c.trackId).name} at ${n2(at)}–${n2(at + len)} s`;
        });
      }
    },
    {
      name: 'add_shape',
      description: 'Add a full-frame colour matte (background) or a rectangle / ellipse graphic.',
      input_schema: {
        type: 'object',
        properties: {
          shape: { type: 'string', enum: ['matte', 'rect', 'ellipse'] },
          start: { type: 'number', description: 'Default: the playhead.' },
          duration: { type: 'number', description: 'Default 5 s.' },
          fill: { type: 'string', description: 'Hex colour.' },
          width: { type: 'number', description: 'Project pixels (rect/ellipse).' },
          height: { type: 'number' },
          x: { type: 'number', description: 'Offset from centre, px.' },
          y: { type: 'number' }
        },
        required: ['shape', 'fill']
      },
      run(i) {
        return edit(store, 'Add shape', (p) => {
          if (!['matte', 'rect', 'ellipse'].includes(i.shape)) throw new Error("shape must be 'matte', 'rect' or 'ellipse'.");
          const at = snap(i.start !== undefined ? num(i.start, 'start') : store.getState().playhead);
          const len = Math.max(0.1, i.duration !== undefined ? num(i.duration, 'duration') : 5);
          const style: Record<string, unknown> = { shape: i.shape, fill: String(i.fill) };
          if (i.width !== undefined) style.w = Math.max(1, num(i.width, 'width'));
          if (i.height !== undefined) style.h = Math.max(1, num(i.height, 'height'));
          const c = shapeClip(p, at, len, style);
          if (i.x !== undefined) c.props.x = num(i.x, 'x');
          if (i.y !== undefined) c.props.y = num(i.y, 'y');
          overwrite(p, [c]);
          return `Added ${c.name.toLowerCase()} ${c.id} on ${trackById(p, c.trackId).name} at ${n2(at)}–${n2(at + len)} s`;
        });
      }
    },
    {
      name: 'add_marker',
      description: 'Drop a marker on the timeline ruler.',
      input_schema: { type: 'object', properties: { time: { type: 'number' }, name: { type: 'string' }, color: { type: 'string', description: 'Hex colour (default yellow).' } }, required: ['time'] },
      run(i) {
        return edit(store, 'Add marker', (p) => {
          const m = { id: uid(), t: snap(num(i.time, 'time')), name: String(i.name ?? ''), color: String(i.color || '#fdd663') };
          p.markers.push(m);
          return `Added marker ${m.id} at ${n2(m.t)} s`;
        });
      }
    },
    {
      name: 'remove_marker',
      description: 'Delete a marker.',
      input_schema: { type: 'object', properties: { marker_id: { type: 'string' } }, required: ['marker_id'] },
      run(i) {
        return edit(store, 'Remove marker', (p) => {
          const k = p.markers.findIndex((m) => m.id === i.marker_id);
          if (k < 0) throw new Error(`There's no marker with id ${i.marker_id}.`);
          p.markers.splice(k, 1);
          return 'Removed the marker';
        });
      }
    },
    {
      name: 'set_in_out',
      description: 'Set or clear the timeline in/out range (used by "play range" and "export in to out"). null clears a point.',
      input_schema: { type: 'object', properties: { in: { type: ['number', 'null'] }, out: { type: ['number', 'null'] } } },
      run(i) {
        return edit(store, 'Set in/out', (p) => {
          if ('in' in i) p.inPoint = i.in === null ? null : snap(num(i.in, 'in'));
          if ('out' in i) p.outPoint = i.out === null ? null : snap(num(i.out, 'out'));
          if (p.inPoint !== null && p.outPoint !== null && p.outPoint <= p.inPoint) throw new Error('out must be after in.');
          return `In ${p.inPoint === null ? 'cleared' : `${n2(p.inPoint)} s`}, out ${p.outPoint === null ? 'cleared' : `${n2(p.outPoint)} s`}`;
        });
      }
    },
    {
      name: 'set_playhead',
      description: 'Move the playhead (pauses playback). Use before taking a look at a frame.',
      input_schema: { type: 'object', properties: { time: { type: 'number', description: 'Timeline seconds.' } }, required: ['time'] },
      run(i) {
        if (store.getState().playing) env.player.pause();
        const t = snap(num(i.time, 'time'));
        store.getState().seek(t);
        return `Playhead at ${n2(t)} s (${timecode(t, fpsOf())})`;
      }
    },
    {
      name: 'set_project',
      description: 'Change the project frame size, aspect preset, frame rate or background colour.',
      input_schema: {
        type: 'object',
        properties: {
          aspect: { type: 'string', enum: ASPECTS.map((a) => a.id), description: 'Preset size: 16:9 1920×1080, 9:16 1080×1920, 1:1 1080×1080, 4:5 1080×1350.' },
          width: { type: 'number' },
          height: { type: 'number' },
          fps: { type: 'number' },
          background: { type: 'string', description: 'Hex colour shown where no clip covers the frame.' }
        }
      },
      run(i) {
        return edit(store, 'Project settings', (p) => {
          const st = p.settings;
          if (i.aspect) {
            const a = ASPECTS.find((x) => x.id === i.aspect);
            if (!a) throw new Error(`aspect must be one of ${ASPECTS.map((x) => x.id).join(', ')}.`);
            st.width = a.w;
            st.height = a.h;
          }
          if (i.width !== undefined) st.width = Math.round(clampN(num(i.width, 'width'), 16, 7680) / 2) * 2;
          if (i.height !== undefined) st.height = Math.round(clampN(num(i.height, 'height'), 16, 7680) / 2) * 2;
          if (i.fps !== undefined) st.fps = clampN(num(i.fps, 'fps'), 1, 240);
          if (i.background) st.background = String(i.background);
          st.aspect = aspectOf(st.width, st.height);
          return `Project is ${st.width}×${st.height} (${st.aspect}) at ${st.fps} fps`;
        });
      }
    },
    {
      name: 'track_settings',
      description: 'Mute, solo, lock, hide or set the volume of a track, or add a new video/audio track.',
      input_schema: {
        type: 'object',
        properties: {
          track: { type: 'string', description: 'Track name, e.g. "A1". Not needed when only adding a track.' },
          muted: { type: 'boolean' },
          solo: { type: 'boolean' },
          locked: { type: 'boolean' },
          hidden: { type: 'boolean', description: 'Video tracks: leave out of the picture.' },
          volume_db: { type: 'number', description: 'Audio track volume in dB (-60..12).' },
          add: { type: 'string', enum: ['video', 'audio'], description: 'Add a new track of this kind.' }
        }
      },
      run(i) {
        return edit(store, 'Track settings', (p) => {
          const out: string[] = [];
          if (i.add) {
            if (i.add !== 'video' && i.add !== 'audio') throw new Error("add must be 'video' or 'audio'.");
            out.push(`added track ${addTrack(p, i.add).name}`);
          }
          if (i.track) {
            const t = findTrack(p, i.track);
            if (i.muted !== undefined) t.muted = bool(i.muted);
            if (i.solo !== undefined) t.solo = bool(i.solo);
            if (i.locked !== undefined) t.locked = bool(i.locked);
            if (i.hidden !== undefined) t.hidden = bool(i.hidden);
            if (i.volume_db !== undefined) t.volume = clampN(num(i.volume_db, 'volume_db'), -60, 12);
            out.push(`${t.name}: ${[t.muted && 'muted', t.solo && 'solo', t.locked && 'locked', t.hidden && 'hidden', `volume ${t.volume} dB`].filter(Boolean).join(', ')}`);
          }
          if (!out.length) throw new Error('Name a track or say which kind to add.');
          return out.join('; ');
        });
      }
    },
    {
      name: 'link_clips',
      description: 'Link clips so they move, trim and delete together (e.g. a picture clip with its sound).',
      input_schema: { type: 'object', properties: { clip_ids: { type: 'array', items: { type: 'string' } } }, required: ['clip_ids'] },
      run(i) {
        return edit(store, 'Link', (p) => {
          const ids: string[] = i.clip_ids || [];
          if (ids.length < 2) throw new Error('Give at least two clips to link.');
          const link = uid();
          for (const id of ids) findClip(p, id).linkId = link;
          return `Linked ${ids.length} clips`;
        });
      }
    },
    {
      name: 'unlink_clips',
      description: 'Unlink clips (and their partners) so picture and sound can be edited separately.',
      input_schema: { type: 'object', properties: { clip_ids: { type: 'array', items: { type: 'string' } } }, required: ['clip_ids'] },
      run(i) {
        return edit(store, 'Unlink', (p) => {
          const ids: string[] = i.clip_ids || [];
          ids.forEach((id) => findClip(p, id));
          const all = withLinked(p, ids);
          for (const id of all) findClip(p, id).linkId = undefined;
          return `Unlinked ${all.length} clip${all.length === 1 ? '' : 's'}`;
        });
      }
    },
    {
      name: 'undo',
      description: 'Undo the last change to the project.',
      input_schema: { type: 'object', properties: {} },
      run() {
        const label = store.getState().undo();
        return label ? `Undid: ${label}` : 'Nothing to undo';
      }
    },
    {
      name: 'redo',
      description: 'Redo the last undone change.',
      input_schema: { type: 'object', properties: {} },
      run() {
        const label = store.getState().redo();
        return label ? `Redid: ${label}` : 'Nothing to redo';
      }
    }
  ];
}
