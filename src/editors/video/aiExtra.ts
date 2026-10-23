// Phase-2 video tools and MCP resources: understand raw clips (index), assemble them from an edit plan (apply_edl),
// caption them from the transcript, and export (lossless where possible). These flow to both the Claude sidebar and
// the MCP control server automatically (they're part of the video editor's AiHooks). Heavy work runs as jobs.
import type { AssistantTool } from '../../store';
import type { AssistantEnv } from './assistant';
import type { Project, Clip, MediaItem, TransitionType, TextStyle } from './model';
import { mediaOf, clipEnd, projectDuration, snapToFrame, serializeProject, TRANSITIONS } from './model';
import { clipsForMedia, overwrite, textClip, setTransition, defaultTransition, addTrack, freeTrack } from './ops';
import { mediaKey } from './media';
import { buildIndex, getIndex, indexSummary, tc, type MediaIndex } from './mediaIndex';
import { exportVideo } from './losslessExport';
import { buildMasks } from './segmentMask';
import { addCaptions } from './proEdit';
import { startJob } from '../../lib/jobs';

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/* ---------- MCP resources (cheap reads of the index) ---------- */

export function videoResources(store: AssistantEnv['store'], tabId: string) {
  const p = store.getState().project;
  const out: { uri: string; name: string; mimeType: string; description?: string }[] = [{ uri: `kea://video/${tabId}/project`, name: 'Video project (JSON)', mimeType: 'application/json', description: 'The whole timeline as structured JSON (media bin, tracks, clips).' }];
  for (const m of p.media) {
    const idx = getIndex(mediaKey(m));
    if (!idx) continue;
    out.push({ uri: `kea://video/${tabId}/media/${m.id}/index`, name: `${m.name} — index`, mimeType: 'application/json', description: 'Scenes, silences and a transcript summary.' });
    if (idx.transcript) out.push({ uri: `kea://video/${tabId}/media/${m.id}/transcript`, name: `${m.name} — transcript`, mimeType: 'text/plain', description: 'Timed transcript to edit from.' });
    if (idx.contactSheet) out.push({ uri: `kea://video/${tabId}/media/${m.id}/contactsheet`, name: `${m.name} — contact sheet`, mimeType: 'image/jpeg', description: 'Keyframes as one image.' });
  }
  return out;
}

const transcriptText = (idx: MediaIndex) => (idx.transcript ? idx.transcript.segments.map((s) => `[${tc(s.start)}–${tc(s.end)}] ${s.text}`).join('\n') : idx.transcriptNote || 'No transcript.');

export async function readVideoResource(store: AssistantEnv['store'], tabId: string, uri: string): Promise<{ text?: string; blob?: string; mimeType: string } | null> {
  const p = store.getState().project;
  if (uri === `kea://video/${tabId}/project`) return { text: serializeProject(p), mimeType: 'application/json' };
  const m = new RegExp(`^kea://video/${tabId}/media/([^/]+)/(index|transcript|contactsheet)$`).exec(uri);
  if (!m) return null;
  const media = p.media.find((x) => x.id === m[1]);
  const idx = media && getIndex(mediaKey(media));
  if (!idx) return { text: `This clip hasn't been indexed yet — call index_media first.`, mimeType: 'text/plain' };
  if (m[2] === 'transcript') return { text: transcriptText(idx), mimeType: 'text/plain' };
  if (m[2] === 'contactsheet') return idx.contactSheet ? { blob: idx.contactSheet.split(',')[1], mimeType: 'image/jpeg' } : { text: 'No contact sheet.', mimeType: 'text/plain' };
  return { text: JSON.stringify({ mediaId: idx.mediaId, duration: idx.duration, scenes: idx.scenes, silences: idx.silences, transcript: idx.transcript ? `${idx.transcript.segments.length} segments` : idx.transcriptNote }, null, 1), mimeType: 'application/json' };
}

/* ---------- The EDL applier (one undo step) ---------- */

export interface EdlEntry {
  kind: 'clip' | 'title' | 'gap';
  mediaId?: string;
  in?: number;
  out?: number;
  start?: number;
  transition?: { type?: TransitionType; duration?: number };
  text?: string;
  duration?: number;
  y?: number;
  style?: Partial<TextStyle>;
}
export interface Edl {
  replace?: boolean;
  settings?: { width?: number; height?: number; fps?: number };
  entries: EdlEntry[];
}

function applyEdl(p: Project, edl: Edl, resolve: (id: string) => MediaItem | undefined): string {
  if (edl.settings) {
    if (edl.settings.width) p.settings.width = even(edl.settings.width);
    if (edl.settings.height) p.settings.height = even(edl.settings.height);
    if (edl.settings.fps) p.settings.fps = Math.max(1, Math.round(edl.settings.fps));
  }
  if (edl.replace !== false) p.clips = [];
  const vTrack = p.tracks.find((t) => t.kind === 'video') || addTrack(p, 'video');
  const aTrack = p.tracks.find((t) => t.kind === 'audio') || addTrack(p, 'audio');
  const fps = p.settings.fps;
  const snap = (t: number) => Math.max(0, snapToFrame(t, fps));
  let at = 0;
  let n = 0;
  for (const e of edl.entries || []) {
    if (e.kind === 'clip') {
      const m = resolve(String(e.mediaId));
      if (!m) throw new Error(`EDL entry ${n + 1}: no media with id ${e.mediaId}.`);
      const start = snap(e.start !== undefined ? e.start : at);
      const clips = clipsForMedia(p, m, start, { vTrack: m.kind === 'audio' ? undefined : vTrack.id, aTrack: aTrack.id, in: e.in, out: e.out, findFree: false });
      overwrite(p, clips);
      const vid = clips.find((c) => c.trackId === vTrack.id) || clips[0];
      at = Math.max(at, Math.max(...clips.map(clipEnd)));
      if (e.transition && vid) {
        const type = (e.transition.type && TRANSITIONS.some((x) => x.id === e.transition!.type) ? e.transition.type : 'dissolve') as TransitionType;
        const tr = defaultTransition(type);
        setTransition(p, vid.id, 'in', e.transition.duration ? { ...tr, duration: e.transition.duration } : tr);
      }
      n++;
    } else if (e.kind === 'title') {
      const dur = Math.max(0.1, e.duration ?? 3);
      const c = textClip(p, snap(e.start ?? at), dur, mapStyle(e.text ?? '', e.style), undefined);
      if (e.y !== undefined) c.props.y = e.y;
      overwrite(p, [c]);
      n++;
    } else if (e.kind === 'gap') {
      at += Math.max(0, e.duration ?? 0);
    }
  }
  return `Assembled ${n} item${n === 1 ? '' : 's'}; timeline is ${projectDuration(p).toFixed(1)} s.`;
}

const mapStyle = (text: string, s: Partial<TextStyle> = {}): Partial<TextStyle> => {
  const out: Partial<TextStyle> = { text };
  for (const k of ['font', 'size', 'color', 'bold', 'italic', 'align', 'box', 'outline', 'outlineWidth'] as const) if ((s as any)[k] !== undefined) (out as any)[k] = (s as any)[k];
  return out;
};

/* ---------- SRT ---------- */

const srtTime = (t: number) => {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const ms = Math.round((t - Math.floor(t)) * 1000);
  const pad = (x: number, n = 2) => String(x).padStart(n, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
};
const toSrt = (segs: { start: number; end: number; text: string }[]) => segs.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(s.end)}\n${s.text}\n`).join('\n');
function parseSrt(text: string): { start: number; end: number; text: string }[] {
  const t = (x: string) => {
    const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(x);
    return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000 : 0;
  };
  return text
    .replace(/\r/g, '')
    .split(/\n\n+/)
    .map((block) => {
      const lines = block.split('\n').filter((l) => l.trim());
      const ti = lines.findIndex((l) => l.includes('-->'));
      if (ti < 0) return null;
      const [a, b] = lines[ti].split('-->');
      return { start: t(a), end: t(b), text: lines.slice(ti + 1).join('\n') };
    })
    .filter((x): x is { start: number; end: number; text: string } => !!x && !!x.text);
}

/* ---------- Tools ---------- */

export function extraVideoTools(env: AssistantEnv, tabId: string): AssistantTool[] {
  const { store } = env;
  const fps = () => store.getState().project.settings.fps;
  const snap = (t: number) => Math.max(0, snapToFrame(t, fps()));
  const edit = (label: string, fn: (p: Project) => string) => {
    let msg = '';
    store.getState().commit(label, (p) => {
      msg = fn(p);
    });
    return msg;
  };
  const mediaById = (id?: string) => store.getState().project.media.find((m) => m.id === id);
  const captionTrack = (p: Project, name?: string) => {
    if (name) {
      const t = p.tracks.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (!t || t.kind !== 'video') throw new Error(`No video track called ${name}.`);
      return t;
    }
    return freeTrack(p, 'video', 0, projectDuration(p) || 1, undefined, true);
  };

  return [
    {
      name: 'index_media',
      description: 'Build a local index of a clip so you can edit it cheaply: a timed transcript (needs a speech model installed in Settings → Voice typing), scene-change list, silence spans and a keyframe contact sheet. Runs as a job (returns a jobId — poll kea_jobs_status). Then read kea://video/<tab>/media/<id>/transcript, /index and /contactsheet. With no media_id, indexes every clip in the bin.',
      input_schema: { type: 'object', properties: { media_id: { type: 'string', description: 'Bin media id; omit to index all.' } } },
      run(i) {
        const items = i.media_id ? [mediaById(i.media_id)].filter(Boolean) as MediaItem[] : store.getState().project.media.filter((m) => m.kind !== 'image');
        if (!items.length) return 'There’s nothing to index (import a clip first).';
        const jobId = startJob('index', async (onProgress, signal) => {
          const summaries: ReturnType<typeof indexSummary>[] = [];
          for (let k = 0; k < items.length; k++) {
            const idx = await buildIndex(items[k], (p, note) => onProgress((k + p) / items.length, note ? `${items[k].name}: ${note}` : undefined), signal);
            summaries.push(indexSummary(idx));
          }
          return summaries;
        });
        return `Indexing ${items.length} clip${items.length === 1 ? '' : 's'} (job ${jobId}). Poll kea_jobs_status {jobId:"${jobId}"} until done, then read the transcript/index resources.`;
      }
    },
    {
      name: 'apply_edl',
      description:
        'Assemble the timeline from an edit plan, in one undo step. edl = {replace?:true (clear first), settings?:{width,height,fps}, entries:[…]}. An entry is {kind:"clip", mediaId, in?, out?, start?, transition?:{type,duration}} (clips append end-to-end unless start is given; a video clip auto-links its audio), {kind:"title", text, start?, duration, y?, style?}, or {kind:"gap", duration}. Build it from the transcript/scenes/silences you read. Import files first (add_media_to_timeline with a path, or kea_open_file) so they’re in the bin.',
      input_schema: {
        type: 'object',
        properties: {
          edl: {
            type: 'object',
            properties: {
              replace: { type: 'boolean' },
              settings: { type: 'object', properties: { width: { type: 'number' }, height: { type: 'number' }, fps: { type: 'number' } } },
              entries: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['clip', 'title', 'gap'] }, mediaId: { type: 'string' }, in: { type: 'number' }, out: { type: 'number' }, start: { type: 'number' }, duration: { type: 'number' }, text: { type: 'string' }, y: { type: 'number' }, transition: { type: 'object' }, style: { type: 'object' } }, required: ['kind'] } }
            },
            required: ['entries']
          }
        },
        required: ['edl']
      },
      run(i) {
        const edl = i.edl as Edl;
        if (!edl || !Array.isArray(edl.entries)) throw new Error('Give an edl with an entries array.');
        for (const e of edl.entries) if (e.kind === 'clip' && !mediaById(e.mediaId)) throw new Error(`No media with id ${e.mediaId} in the bin. Import it first.`);
        return edit('Apply edit plan', (p) => applyEdl(p, edl, (id) => p.media.find((m) => m.id === id)));
      }
    },
    {
      name: 'add_captions',
      description: 'Add burned-in captions from a clip’s transcript (index_media it first). Captions are placed at the right timeline times for wherever that clip sits (trims and cuts are followed). One undo step.',
      input_schema: { type: 'object', properties: { media_id: { type: 'string' }, track: { type: 'string', description: 'Video track name; default a new top track.' }, max_words: { type: 'number', description: 'Words per caption line (default 5).' } }, required: [] },
      run(i) {
        const proj = store.getState().project;
        const media = i.media_id ? mediaById(i.media_id) : proj.media.find((m) => getIndex(mediaKey(m))?.transcript);
        if (!media) throw new Error('No indexed clip with a transcript. Run index_media first.');
        const idx = getIndex(mediaKey(media));
        if (!idx) throw new Error('Index this clip first with index_media.');
        if (!idx.transcript || !idx.transcript.segments.length) throw new Error(idx.transcriptNote || 'No speech was found in this clip.');
        return edit('Add captions', (p) => {
          const track = captionTrack(p, i.track);
          const n = addCaptions(p, media, track.id, { maxWords: i.max_words });
          return `Added ${n} caption${n === 1 ? '' : 's'} on ${track.name}.`;
        });
      }
    },
    {
      name: 'export_captions',
      description: 'Return a clip’s transcript as SRT or VTT subtitle text.',
      input_schema: { type: 'object', properties: { media_id: { type: 'string' }, format: { type: 'string', enum: ['srt', 'vtt'] } }, required: [] },
      run(i) {
        const proj = store.getState().project;
        const media = i.media_id ? mediaById(i.media_id) : proj.media.find((m) => getIndex(mediaKey(m))?.transcript);
        const idx = media && getIndex(mediaKey(media));
        if (!idx?.transcript) throw new Error('No transcript. Run index_media first.');
        const srt = toSrt(idx.transcript.segments);
        return (i.format === 'vtt' ? 'WEBVTT\n\n' + srt.replace(/,(\d{3})/g, '.$1') : srt);
      }
    },
    {
      name: 'import_captions',
      description: 'Turn SRT subtitle text into burned-in caption clips at those times. One undo step.',
      input_schema: { type: 'object', properties: { srt: { type: 'string' }, track: { type: 'string' } }, required: ['srt'] },
      run(i) {
        const cues = parseSrt(String(i.srt || ''));
        if (!cues.length) throw new Error('No captions found in that text.');
        return edit('Import captions', (p) => {
          const track = captionTrack(p, i.track);
          const y = Math.round(p.settings.height * 0.33);
          for (const c of cues) {
            const t = textClip(p, snap(c.start), Math.max(0.3, c.end - c.start), { text: c.text, align: 'center', box: '#000000' }, track.id);
            t.props.y = y;
            overwrite(p, [t]);
          }
          return `Added ${cues.length} caption${cues.length === 1 ? '' : 's'} on ${track.name}.`;
        });
      }
    },
    {
      name: 'remove_background',
      description:
        'Remove the background from a video clip with on-device AI — no green screen. The subject is cut out and whatever is behind the clip (another track, or the project background) shows through. Needs a background-removal model installed in Settings → AI image tools (MODNet is a small, fast default). Masks are precomputed as a job (returns a jobId — poll kea_jobs_status); the cutout appears in both preview and export once it finishes. Target a clip with clip_id, or every clip using a bin item with media_id. enabled:false turns it back off.',
      input_schema: { type: 'object', properties: { clip_id: { type: 'string' }, media_id: { type: 'string', description: 'Affects all clips using this bin item.' }, enabled: { type: 'boolean', description: 'Default true.' } }, required: [] },
      run(i) {
        const enabled = i.enabled !== false;
        const proj = store.getState().project;
        let media: MediaItem | undefined;
        const targets = proj.clips.filter((c) => {
          if (c.kind !== 'media') return false;
          if (i.clip_id) return c.id === i.clip_id;
          if (i.media_id) return c.mediaId === i.media_id;
          return false;
        });
        if (!targets.length) throw new Error('Give a clip_id or media_id that matches a video clip on the timeline.');
        const msg = edit(enabled ? 'Remove background' : 'Restore background', (p) => {
          let n = 0;
          for (const c of p.clips) {
            if (c.kind !== 'media') continue;
            if (i.clip_id ? c.id === i.clip_id : i.media_id ? c.mediaId === i.media_id : false) {
              c.removeBg = { enabled };
              if (!media) media = mediaOf(p, c) || undefined;
              n++;
            }
          }
          return `${enabled ? 'Enabled' : 'Disabled'} AI background removal on ${n} clip${n === 1 ? '' : 's'}.`;
        });
        if (!enabled) return msg;
        if (!media || media.kind === 'image') throw new Error('Background removal needs a video clip.');
        const target = media;
        const jobId = startJob('segment', async (onProgress, signal) => buildMasks(target, onProgress, signal));
        return `${msg} Masking frames (job ${jobId}). Poll kea_jobs_status {jobId:"${jobId}"}; once done the cutout shows in preview and export.`;
      }
    },
    {
      name: 'export_video',
      description: 'Export the timeline to a file (runs as a job — poll kea_jobs_status). With lossless:true, stream-copies with no re-encode when the timeline is a single unmodified trimmed clip, otherwise re-encodes at high quality (the result says which). format: mp4 (default), webm, m4a or wav.',
      input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute output path.' }, lossless: { type: 'boolean' }, format: { type: 'string', enum: ['mp4', 'webm', 'm4a', 'wav'] } }, required: ['path'] },
      run(i) {
        if (!i.path) throw new Error('Give an absolute output path.');
        const project = store.getState().project;
        const jobId = startJob('export', async (onProgress, signal) => {
          const r = await exportVideo(project, { path: String(i.path), lossless: !!i.lossless, format: i.format }, (f, note) => onProgress(f, note), signal);
          return r;
        });
        return `Exporting (job ${jobId}). Poll kea_jobs_status {jobId:"${jobId}"}; the result says the output path and whether it was stream-copied or re-encoded.`;
      }
    }
  ];
}
