import { uid } from '../../lib/util';
import { toast } from '../../store';
import type { Store } from './state';
import type { Clip, MediaItem, TransitionType } from './model';
import { clipEnd, projectDuration, snapToFrame, isAudioClip } from './model';
import { splitAt, deleteClips, withLinked, paste, rippleDeleteGap, clipsForMedia, overwrite, insert, isLocked, setTransition, defaultTransition, textClip, shapeClip } from './ops';
import type { TextStyle, ShapeStyle } from './model';

/* Timeline commands shared by the keyboard, toolbar, menus and drag-and-drop. */

const MARKER_COLOURS = ['#fdd663', '#81c995', '#f28b82', '#a8c7fa', '#c58af9', '#78d9ec'];

export function splitAtPlayhead(store: Store) {
  const s = store.getState();
  const t = snapToFrame(s.playhead, s.project.settings.fps);
  const under = s.sel.filter((id) => {
    const c = s.project.clips.find((x) => x.id === id);
    return c && c.start < t && clipEnd(c) > t;
  });
  const p0 = s.project;
  const ids = under.length ? withLinked(p0, under) : p0.clips.map((c) => c.id);
  const any = p0.clips.some((c) => ids.includes(c.id) && !isLocked(p0, c) && c.start + 1 / 60 < t && clipEnd(c) - 1 / 60 > t);
  if (!any) return toast('Nothing under the playhead to split');
  s.commit('Split', (p) => void splitAt(p, t, under.length ? under : undefined));
}

export function deleteSelection(store: Store, ripple: boolean) {
  const s = store.getState();
  if (s.selTransition) {
    const tr = s.selTransition;
    s.commit('Remove transition', (p) => void setTransition(p, tr.clipId, tr.edge, null));
    return;
  }
  if (s.selMarker) {
    const id = s.selMarker;
    s.commit('Delete marker', (p) => void (p.markers = p.markers.filter((m) => m.id !== id)));
    return;
  }
  if (!s.sel.length) return;
  const ids = s.sel;
  s.commit(ripple ? 'Ripple delete' : 'Delete', (p) => void deleteClips(p, ids, ripple));
}

export function copySelection(store: Store, cut = false) {
  const s = store.getState();
  if (!s.sel.length) return;
  const ids = new Set(withLinked(s.project, s.sel));
  store.setState({ clipboard: structuredClone(s.project.clips.filter((c) => ids.has(c.id))) });
  if (cut) s.commit('Cut', (p) => void deleteClips(p, [...ids], false));
}

export function pasteClipboard(store: Store) {
  const s = store.getState();
  if (!s.clipboard?.length) return;
  const clip = s.clipboard;
  let made: Clip[] = [];
  s.commit('Paste', (p) => void (made = paste(p, clip, snapToFrame(s.playhead, p.settings.fps))));
  s.select(made.map((c) => c.id));
  if (made.length) s.seek(Math.max(...made.map(clipEnd)));
}

export function duplicateSelection(store: Store) {
  const s = store.getState();
  if (!s.sel.length) return;
  const ids = new Set(withLinked(s.project, s.sel));
  const clips = s.project.clips.filter((c) => ids.has(c.id));
  const end = Math.max(...clips.map(clipEnd));
  let made: Clip[] = [];
  s.commit('Duplicate', (p) => void (made = paste(p, clips, end)));
  s.select(made.map((c) => c.id));
}

export function selectAll(store: Store) {
  const s = store.getState();
  s.select(s.project.clips.filter((c) => !isLocked(s.project, c)).map((c) => c.id));
}

export function addMarker(store: Store, t?: number) {
  const s = store.getState();
  const at = snapToFrame(t ?? s.playhead, s.project.settings.fps);
  const existing = s.project.markers.find((m) => Math.abs(m.t - at) < 1 / 120);
  if (existing) return store.setState({ selMarker: existing.id, sel: [] });
  const id = uid();
  s.commit('Add marker', (p) => {
    p.markers.push({ id, t: at, name: `Marker ${p.markers.length + 1}`, color: MARKER_COLOURS[p.markers.length % MARKER_COLOURS.length] });
    p.markers.sort((a, b) => a.t - b.t);
  });
  store.setState({ selMarker: id, sel: [] });
}

export function setInOut(store: Store, which: 'in' | 'out' | 'clear') {
  const s = store.getState();
  const t = snapToFrame(s.playhead, s.project.settings.fps);
  s.commit(which === 'clear' ? 'Clear in and out' : which === 'in' ? 'Set in point' : 'Set out point', (p) => {
    if (which === 'clear') {
      p.inPoint = null;
      p.outPoint = null;
    } else if (which === 'in') {
      p.inPoint = t;
      if (p.outPoint !== null && p.outPoint <= t) p.outPoint = null;
    } else {
      p.outPoint = t;
      if (p.inPoint !== null && p.inPoint >= t) p.inPoint = null;
    }
  });
}

/** Every cut, clip edge and marker, for jumping with Up / Down. */
export function editPoints(store: Store) {
  const p = store.getState().project;
  const pts = new Set<number>([0, projectDuration(p)]);
  for (const c of p.clips) {
    pts.add(Math.round(c.start * 1000) / 1000);
    pts.add(Math.round(clipEnd(c) * 1000) / 1000);
  }
  return [...pts].sort((a, b) => a - b);
}

export function jumpEdit(store: Store, dir: 1 | -1) {
  const s = store.getState();
  const pts = editPoints(store);
  const t = s.playhead;
  const next = dir > 0 ? pts.find((x) => x > t + 1e-3) : [...pts].reverse().find((x) => x < t - 1e-3);
  if (next !== undefined) s.seek(next);
}

export function linkSelection(store: Store, link: boolean) {
  const s = store.getState();
  if (!s.sel.length) return;
  const ids = link ? s.sel : withLinked(s.project, s.sel);
  if (link && ids.length < 2) return toast('Select a picture clip and a sound clip to link');
  const id = uid();
  s.commit(link ? 'Link' : 'Unlink', (p) => {
    for (const c of p.clips) if (ids.includes(c.id)) c.linkId = link ? id : undefined;
  });
}

export function nudge(store: Store, frames: number) {
  const s = store.getState();
  if (!s.sel.length) return;
  const d = frames / s.project.settings.fps;
  const ids = new Set(withLinked(s.project, s.sel));
  s.commit('Nudge', (p) => {
    for (const c of p.clips) if (ids.has(c.id) && !isLocked(p, c)) c.start = Math.max(0, c.start + d);
  });
}

/** Put media on the timeline at `at` (overwrite or insert), picture on `vTrack` and sound on `aTrack` when given. */
export function placeMedia(store: Store, m: MediaItem, at: number, opts: { vTrack?: string; aTrack?: string; mode?: 'overwrite' | 'insert'; in?: number; out?: number } = {}) {
  const s = store.getState();
  let made: Clip[] = [];
  s.commit(opts.mode === 'insert' ? 'Insert' : 'Overwrite', (p) => {
    const t = snapToFrame(Math.max(0, at), p.settings.fps);
    // Default targets: the lowest video track and the first audio track.
    const vTrack = opts.vTrack || p.tracks.find((x) => x.kind === 'video' && !x.locked)?.id;
    const aTrack = opts.aTrack || p.tracks.find((x) => x.kind === 'audio' && !x.locked)?.id;
    made = clipsForMedia(p, m, t, { vTrack, aTrack, in: opts.in, out: opts.out });
    if (opts.mode === 'insert') insert(p, made);
    else overwrite(p, made);
  });
  s.select(made.map((c) => c.id));
  return made;
}

export function appendMedia(store: Store, items: MediaItem[]) {
  for (const m of items) {
    const p = store.getState().project;
    // Picture media goes after the last picture clip; sound-only after the last sound.
    const kind = m.hasVideo || m.kind === 'image' ? 'video' : 'audio';
    const ends = p.clips.filter((c) => (kind === 'audio') === isAudioClip(p, c)).map(clipEnd);
    placeMedia(store, m, ends.length ? Math.max(...ends) : 0);
  }
}

export function addText(store: Store, style: Partial<TextStyle> = {}, at?: number, duration = 3, y = 0) {
  const s = store.getState();
  let id = '';
  s.commit('Add text', (p) => {
    const c = textClip(p, snapToFrame(at ?? s.playhead, p.settings.fps), duration, style);
    c.props.y = y;
    p.clips.push(c);
    id = c.id;
  });
  s.select([id]);
}

export function addShape(store: Store, style: Partial<ShapeStyle>, at?: number, duration = 5) {
  const s = store.getState();
  let id = '';
  s.commit(style.shape === 'matte' ? 'Add colour matte' : 'Add shape', (p) => {
    const c = shapeClip(p, snapToFrame(at ?? s.playhead, p.settings.fps), duration, style);
    p.clips.push(c);
    id = c.id;
  });
  s.select([id]);
}

export function addTransitionAt(store: Store, clipId: string, edge: 'in' | 'out', type: TransitionType) {
  const s = store.getState();
  let ref: ReturnType<typeof setTransition> = null;
  s.commit('Add transition', (p) => void (ref = setTransition(p, clipId, edge, defaultTransition(type))));
  if (ref) store.setState({ selTransition: ref, sel: [] });
}

export function closeGap(store: Store, trackId: string, t: number) {
  const s = store.getState();
  let len = 0;
  s.commit('Ripple delete gap', (p) => void (len = rippleDeleteGap(p, trackId, t)));
  if (!len) toast('No gap there');
}

