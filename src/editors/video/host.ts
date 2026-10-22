import { api } from '../../lib/api';
import { extOf } from '../../lib/fileTypes';

/*
 * Main-process capabilities the video editor can use when the host provides them.
 * Everything works without them (files are read whole into memory and exports are
 * written in one go), but big videos need the streaming versions:
 *
 *   window.api.video.mediaUrl(path)  → a URL <video>, <audio> and fetch() can stream from with
 *                                      HTTP Range requests (e.g. "kea-media://file/<encoded path>").
 *   window.api.video.openWrite(path) → id of a file opened for writing (created/truncated).
 *   window.api.video.writeAt(id, position, bytes) → write bytes at a byte offset.
 *   window.api.video.closeWrite(id, abort) → close it (abort = delete the partial file).
 */
export interface VideoHost {
  mediaUrl?(path: string): string;
  openWrite?(path: string): Promise<string>;
  writeAt?(id: string, position: number, data: Uint8Array): Promise<void>;
  closeWrite?(id: string, abort?: boolean): Promise<void>;
}

export const host = (): VideoHost => ((window as any).api?.video as VideoHost) || {};
export const canStreamRead = () => typeof host().mediaUrl === 'function';
export const canStreamWrite = () => typeof host().openWrite === 'function' && typeof host().writeAt === 'function' && typeof host().closeWrite === 'function';

const MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml'
};
export const mimeOf = (name: string) => MIME[extOf(name)] || 'application/octet-stream';

export const VIDEO_EXTS = ['mp4', 'm4v', 'mov', 'webm', 'mkv'];
export const AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac'];
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];

/* Files held in memory, by key (the path, or "mem:<id>" for media without one). */
const blobs = new Map<string, Blob>();
const urls = new Map<string, string>();

/** Remember bytes we already have (the opened tab, a dropped file, a dialog result) so they aren't read twice. */
export function seedBlob(key: string, data: Blob | Uint8Array, name = key) {
  // (Files picked from disk come without their bytes when Kea can stream them: nothing to remember then.)
  if (!(data instanceof Blob) && !data?.length && !key.startsWith('mem:')) return;
  blobs.set(key, data instanceof Blob ? data : new Blob([data as BlobPart], { type: mimeOf(name) }));
}

export async function getBlob(key: string): Promise<Blob> {
  const have = blobs.get(key);
  if (have) return have;
  if (key.startsWith('mem:')) throw new Error('This media is no longer in memory. Import it again.');
  const f = await api.readFile(key);
  const b = new Blob([f.data as BlobPart], { type: mimeOf(key) });
  blobs.set(key, b);
  return b;
}

/** A URL a media element can play. */
export async function playUrl(key: string): Promise<string> {
  const h = host();
  if (h.mediaUrl && !key.startsWith('mem:') && !blobs.has(key)) return h.mediaUrl(key);
  let u = urls.get(key);
  if (!u) {
    u = URL.createObjectURL(await getBlob(key));
    urls.set(key, u);
  }
  return u;
}

export async function fileExists(path: string) {
  if (!path || path.startsWith('mem:')) return blobs.has(path);
  if (blobs.has(path)) return true;
  try {
    return await api.fileExists(path);
  } catch {
    return false;
  }
}

/** Where an export is written: streamed to disk when the host can, otherwise kept in memory and written at the end. */
export interface FileSink {
  /** mediabunny StreamTarget-style writer, or null when buffering in memory. */
  write: ((position: number, data: Uint8Array) => Promise<void>) | null;
  finish(buffer: ArrayBuffer | null): Promise<void>;
  abort(): Promise<void>;
}

export async function openFileSink(path: string): Promise<FileSink> {
  const h = host();
  if (canStreamWrite()) {
    const id = await h.openWrite!(path);
    return {
      write: (pos, data) => h.writeAt!(id, pos, data),
      finish: () => h.closeWrite!(id, false),
      abort: () => h.closeWrite!(id, true)
    };
  }
  return {
    write: null,
    finish: async (buffer) => {
      if (buffer) await api.writeFile(path, new Uint8Array(buffer));
    },
    abort: async () => {}
  };
}
