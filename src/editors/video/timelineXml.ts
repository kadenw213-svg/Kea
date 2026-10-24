// Timeline export for finishing in DaVinci Resolve or Adobe Premiere: Final Cut Pro 7 XML ("xmeml" v5), the format
// both import natively. Carries every cut on every track (linked to the original files, so nothing is re-encoded),
// clip speed, opacity, position / scale / rotation, sound levels and dissolves. What has no XML equivalent (Kea's
// grades, LUTs, titles, keys, background removal, speed ramps…) is listed in the notes so it can be redone there.
import type { Project, Clip, MediaItem } from './model';
import { clipDuration, clipEnd, mediaOf, neighbours, propAt } from './model';

/** Sequence rate: xmeml's timebase (whole number) + NTSC flag for 23.976 / 29.97 / 59.94. */
function rateOf(fps: number) {
  const ntsc = [23.976, 29.97, 59.94, 119.88].some((r) => Math.abs(fps - r) < 0.01);
  return { timebase: Math.round(fps), ntsc, fps: ntsc ? (Math.round(fps) * 1000) / 1001 : fps };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** file://localhost/ URL for a local path (Windows drive letters kept, everything else escaped per RFC 2396). */
export function pathUrl(path: string) {
  const parts = path.replace(/\\/g, '/').split('/').filter((p, i) => p !== '' || i === 0);
  const enc = parts.map((p, i) => (i === 0 && /^[A-Za-z]:$/.test(p) ? `${p[0]}%3a` : encodeURIComponent(p).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)));
  return `file://localhost/${enc.join('/').replace(/^\//, '')}`;
}

export interface TimelineXml {
  xml: string;
  /** What didn't carry over, in plain English. */
  notes: string[];
}

/** The project (or the part between range[0] and range[1]) as FCP7 XML. */
export function timelineXml(p: Project, name: string, range?: [number, number]): TimelineXml {
  const R = rateOf(p.settings.fps);
  const fr = (sec: number) => Math.round(sec * R.fps);
  const rate = `<rate><timebase>${R.timebase}</timebase><ntsc>${R.ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
  const [a, b] = range || [0, Math.max(0, ...p.clips.map(clipEnd))];
  const notes = new Set<string>();
  const fileIds = new Map<string, string>();
  let clipNo = 0;
  const W = p.settings.width;
  const H = p.settings.height;

  const fileEl = (m: MediaItem) => {
    const known = fileIds.get(m.id);
    if (known) return `<file id="${known}"/>`;
    const id = `file-${fileIds.size + 1}`;
    fileIds.set(m.id, id);
    if (!m.path) notes.add(`${m.name} only exists inside Kea (no file on disk): relink it after importing.`);
    const mr = rateOf(m.fps || p.settings.fps);
    const mrate = `<rate><timebase>${mr.timebase}</timebase><ntsc>${mr.ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
    const video = m.hasVideo || m.kind === 'image' ? `<video><samplecharacteristics>${mrate}<width>${m.width}</width><height>${m.height}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></video>` : '';
    const audio = m.hasAudio ? `<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>` : '';
    return `<file id="${id}"><name>${esc(m.name)}</name><pathurl>${esc(pathUrl(m.path || m.name))}</pathurl>${mrate}<duration>${Math.max(1, fr(m.duration || 10))}</duration><media>${video}${audio}</media></file>`;
  };

  const param = (id: string, label: string, value: string, min?: number, max?: number) =>
    `<parameter><parameterid>${id}</parameterid><name>${label}</name>${min !== undefined ? `<valuemin>${min}</valuemin><valuemax>${max}</valuemax>` : ''}<value>${value}</value></parameter>`;
  const effect = (name: string, id: string, cat: string, type: string, media: string, params: string) =>
    `<filter><effect><name>${name}</name><effectid>${id}</effectid><effectcategory>${cat}</effectcategory><effecttype>${type}</effecttype><mediatype>${media}</mediatype>${params}</effect></filter>`;

  /** Note what about this clip has no XML equivalent. */
  const lossy = (c: Clip) => {
    if (c.lut) notes.add(`${c.name}: LUT (${c.lut.path.split(/[\\/]/).pop()}) — apply it again in the colour page.`);
    if (c.colour && Object.values(c.colour).some((v) => Math.abs(v as number) > 1e-4)) notes.add(`${c.name}: Kea colour grade — redo it in the colour page (measure_picture numbers help match).`);
    if (c.key?.enabled) notes.add(`${c.name}: chroma key — key it again.`);
    if (c.removeBg?.enabled) notes.add(`${c.name}: AI background removal — not transferable.`);
    if (c.ramp?.length) notes.add(`${c.name}: speed ramp — exported at its average speed.`);
    if (c.freeze !== undefined) notes.add(`${c.name}: freeze frame — exported as a still of that frame's source time.`);
    if (c.blend && c.blend !== 'normal') notes.add(`${c.name}: blend mode ${c.blend} — set it again (composite mode).`);
    if (Object.values(c.kf || {}).some((k) => (k as unknown[])?.length)) notes.add(`${c.name}: keyframed animation — exported at its starting values.`);
  };

  const clipItem = (c: Clip, kind: 'video' | 'audio') => {
    const m = mediaOf(p, c);
    if (!m) return '';
    // Trim to the exported range.
    const s0 = Math.max(c.start, a);
    const s1 = Math.min(clipEnd(c), b);
    if (s1 - s0 < 1 / R.fps / 2) return '';
    const speed = c.ramp?.length ? (c.out - c.in) / clipDuration(c) : c.speed;
    const srcAt = (t: number) => (c.reverse ? c.out - (t - c.start) * speed : c.in + (t - c.start) * speed);
    let inS = srcAt(s0);
    let outS = srcAt(s1);
    if (c.freeze !== undefined) inS = outS = c.freeze;
    if (inS > outS) [inS, outS] = [outS, inS];
    const start = fr(s0 - a);
    const end = fr(s1 - a);
    const id = `clipitem-${++clipNo}`;
    const filters: string[] = [];
    if (kind === 'video') {
      if (Math.abs(speed - 1) > 1e-3 || c.reverse)
        filters.push(effect('Time Remap', 'timeremap', 'motion', 'motion', 'video', param('variablespeed', 'variablespeed', '0', 0, 1) + param('speed', 'speed', String(Math.round(speed * 10000) / 100 * (c.reverse ? -1 : 1)), -100000, 100000) + param('reverse', 'reverse', c.reverse ? 'TRUE' : 'FALSE') + param('frameblending', 'frameblending', 'FALSE')));
      // Kea's scale 100 = fitted to the frame; xmeml's 100 = the media's own pixels.
      const fit = m.width && m.height ? Math.min(W / m.width, H / m.height) : 1;
      const scale = propAt(c, 'scale', c.start) * fit;
      const x = propAt(c, 'x', c.start);
      const y = propAt(c, 'y', c.start);
      const rot = propAt(c, 'rotation', c.start);
      if (Math.abs(scale - 100) > 0.01 || x || y || rot)
        filters.push(effect('Basic Motion', 'basic', 'motion', 'motion', 'video', param('scale', 'Scale', String(Math.round(scale * 100) / 100), 0, 1000) + param('rotation', 'Rotation', String(rot), -8640, 8640) + param('center', 'Center', `<horiz>${Math.round((x / W) * 10000) / 10000}</horiz><vert>${Math.round((y / H) * 10000) / 10000}</vert>`)));
      const op = propAt(c, 'opacity', c.start);
      if (op < 99.99) filters.push(effect('Opacity', 'opacity', 'motion', 'motion', 'video', param('opacity', 'opacity', String(Math.round(op * 100) / 100), 0, 100)));
      if (c.crop && (c.crop.left || c.crop.right || c.crop.top || c.crop.bottom))
        filters.push(effect('Crop', 'crop', 'motion', 'motion', 'video', param('left', 'left', String(c.crop.left), 0, 100) + param('right', 'right', String(c.crop.right), 0, 100) + param('top', 'top', String(c.crop.top), 0, 100) + param('bottom', 'bottom', String(c.crop.bottom), 0, 100)));
      lossy(c);
    } else {
      // Audio Levels takes a linear gain (1 = 0 dB).
      const db = propAt(c, 'volume', c.start) + (c.props.gain || 0);
      if (Math.abs(db) > 0.01) filters.push(effect('Audio Levels', 'audiolevels', 'audiolevels', 'audiolevels', 'audio', param('level', 'Level', String(Math.round(Math.pow(10, db / 20) * 10000) / 10000), 0.00001, 3.98109)));
      if (c.audioFx) notes.add(`${c.name}: Kea sound effects (EQ / compressor / noise reduction) — redo them on the audio page.`);
    }
    const src = kind === 'audio' ? `<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>` : '';
    return `<clipitem id="${id}"><name>${esc(c.name)}</name><enabled>TRUE</enabled><duration>${Math.max(1, fr(m.duration || clipDuration(c)))}</duration>${rate}<start>${start}</start><end>${end}</end><in>${fr(inS)}</in><out>${Math.max(fr(inS) + 1, fr(outS))}</out>${fileEl(m)}${src}${filters.join('')}</clipitem>`;
  };

  const transition = (c: Clip, edge: 'in' | 'out', kind: 'video' | 'audio') => {
    const { prev, next } = neighbours(p, c);
    const tr = edge === 'in' ? c.trIn : c.trOut;
    if (!tr) return '';
    if (edge === 'out' && next) return ''; // the next clip's "in" covers that cut
    const d = tr.duration;
    const cut = edge === 'in' ? c.start : clipEnd(c);
    const [t0, t1, align] = edge === 'in' ? (prev ? [cut - d / 2, cut + d / 2, 'center'] : [cut, cut + d, 'start-black']) : [cut - d, cut, 'end-black'];
    if (t1 <= a || t0 >= b) return '';
    if (kind === 'video' && !['dissolve', 'dipBlack', 'dipWhite'].includes(tr.type)) notes.add(`${c.name}: ${tr.type} transition — exported as a cross dissolve.`);
    const dip = tr.type === 'dipBlack' || tr.type === 'dipWhite';
    const eff =
      kind === 'audio'
        ? '<effect><name>Cross Fade (+3dB)</name><effectid>KGAudioTransCrossFade3dB</effectid><effecttype>transition</effecttype><mediatype>audio</mediatype></effect>'
        : dip
          ? `<effect><name>Dip to Color Dissolve</name><effectid>dipcolor</effectid><effectcategory>Dissolve</effectcategory><effecttype>transition</effecttype><mediatype>video</mediatype>${param('dipcolor', 'Color', `<alpha>255</alpha><red>${tr.type === 'dipWhite' ? 255 : 0}</red><green>${tr.type === 'dipWhite' ? 255 : 0}</green><blue>${tr.type === 'dipWhite' ? 255 : 0}</blue>`)}</effect>`
          : '<effect><name>Cross Dissolve</name><effectid>Cross Dissolve</effectid><effectcategory>Dissolve</effectcategory><effecttype>transition</effecttype><mediatype>video</mediatype></effect>';
    return `<transitionitem>${rate}<start>${fr(Math.max(a, t0) - a)}</start><end>${fr(Math.min(b, t1) - a)}</end><alignment>${align}</alignment>${eff}</transitionitem>`;
  };

  const tracksOf = (kind: 'video' | 'audio') =>
    p.tracks
      .filter((t) => t.kind === kind)
      .map((t) => {
        const items = p.clips
          .filter((c) => c.trackId === t.id)
          .sort((x, y) => x.start - y.start)
          .map((c) => {
            if (c.kind !== 'media') {
              if (kind === 'video') notes.add(`${c.kind === 'text' ? `Title "${(c.text?.text || '').slice(0, 30)}"` : `Shape ${c.name}`} — Kea titles and shapes don't transfer: recreate them (or export a still / a video of just the titles).`);
              return '';
            }
            const m = mediaOf(p, c);
            if (kind === 'video' && m?.kind === 'audio') return '';
            return transition(c, 'in', kind) + clipItem(c, kind) + transition(c, 'out', kind);
          })
          .join('');
        const off = kind === 'video' ? t.hidden : t.muted;
        return `<track>${items}<enabled>${off ? 'FALSE' : 'TRUE'}</enabled><locked>${t.locked ? 'TRUE' : 'FALSE'}</locked></track>`;
      })
      .join('');

  if (p.settings.master && (p.settings.master.gain || p.settings.master.limiter)) notes.add(`Loudness: Kea's master gain (${p.settings.master.gain} dB) and limiter — set the mix level again (Kea measured the target).`);
  const video = tracksOf('video');
  const audio = tracksOf('audio');
  const dur = fr(b - a);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
<sequence id="sequence-1"><name>${esc(name)}</name><duration>${dur}</duration>${rate}<timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>${R.ntsc ? 'DF' : 'NDF'}</displayformat></timecode>
<media>
<video><format><samplecharacteristics>${rate}<width>${W}</width><height>${H}</height><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>${video}</video>
<audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>${audio}</audio>
</media>
</sequence>
</xmeml>
`;
  return { xml, notes: [...notes] };
}
