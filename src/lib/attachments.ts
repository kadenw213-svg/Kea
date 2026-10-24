// Files the student gives Claude in the sidebar (a flier to copy, a sketch, concept images, a PDF brief). Claude sees
// them with the message, and the editors' design tools can place an attached image into the open file by its id
// ("a1"). Over MCP there's no sidebar, so the same tools also take a file path.
import { api } from './api';
import { extOf } from './fileTypes';

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  /** The original file, as a data URL (what gets placed into a file). */
  dataUrl: string;
  /** Images: pixel size. */
  width?: number;
  height?: number;
}

const store = new Map<string, Attachment>();
let counter = 0;

const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };
export const ATTACHABLE = [...Object.keys(IMAGE_MIME), 'pdf'];
export const isAttachable = (name: string) => ATTACHABLE.includes(extOf(name));

const toDataUrl = (blob: Blob) =>
  new Promise<string>((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result));
    r.onerror = () => rej(r.error);
    r.readAsDataURL(blob);
  });

export const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('That image couldn’t be read.'));
    img.src = src;
  });

/** Keep a file the student attached; returns it with its id. */
export async function addAttachment(name: string, data: Uint8Array | Blob): Promise<Attachment> {
  const ext = extOf(name);
  const mime = ext === 'pdf' ? 'application/pdf' : IMAGE_MIME[ext];
  if (!mime) throw new Error(`${name}: Claude can be given images (PNG, JPEG, GIF, WebP, BMP, SVG) and PDFs.`);
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mime });
  const a: Attachment = { id: `a${++counter}`, name, mime, dataUrl: await toDataUrl(blob.type ? blob : new Blob([blob], { type: mime })) };
  if (mime.startsWith('image/')) {
    const img = await loadImage(a.dataUrl);
    a.width = img.naturalWidth;
    a.height = img.naturalHeight;
  }
  store.set(a.id, a);
  return a;
}

export const attachment = (id: string) => store.get(id);

const LONG_EDGE = 1568; // what Claude looks at; bigger pictures are scaled down by the API anyway
const MAX_IMAGE_BYTES = 3.7e6; // base64 of the 5 MB per-image limit

/** The content block that shows an attachment to Claude (images scaled down to what it reads; PDFs as documents). */
export async function contentBlock(a: Attachment): Promise<any> {
  const b64 = (u: string) => u.slice(u.indexOf(',') + 1);
  if (a.mime === 'application/pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64(a.dataUrl) }, title: a.name };
  const native = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(a.mime);
  const big = Math.max(a.width || 0, a.height || 0) > LONG_EDGE || a.dataUrl.length > MAX_IMAGE_BYTES;
  if (native && !big) return { type: 'image', source: { type: 'base64', media_type: a.mime, data: b64(a.dataUrl) } };
  const img = await loadImage(a.dataUrl);
  const s = Math.min(1, LONG_EDGE / Math.max(img.naturalWidth || 1, img.naturalHeight || 1));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round((img.naturalWidth || LONG_EDGE) * s));
  c.height = Math.max(1, Math.round((img.naturalHeight || LONG_EDGE) * s));
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, c.width, c.height);
  const png = a.mime === 'image/png' || a.mime === 'image/svg+xml';
  let url = c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.9);
  if (url.length > MAX_IMAGE_BYTES) url = c.toDataURL('image/jpeg', 0.85);
  return { type: 'image', source: { type: 'base64', media_type: url.slice(5, url.indexOf(';')), data: b64(url) } };
}

/** How an attachment is named to Claude in the message text. */
export const describeAttachment = (a: Attachment) =>
  `[Attached ${a.mime === 'application/pdf' ? 'PDF' : 'image'} ${a.id}: “${a.name}”${a.width ? `, ${a.width} × ${a.height} px` : ''}${a.mime.startsWith('image/') ? `. Tools that place images take attachment: "${a.id}".` : ''}]`;

/** The input fields every image-placing tool accepts. */
export const imageSource = {
  attachment: { type: 'string', description: 'Id of an image the student attached in the chat, like "a1".' },
  path: { type: 'string', description: 'Or: the full path of an image file on this computer.' }
};

export interface PlacedImage {
  name: string;
  dataUrl: string;
  width: number;
  height: number;
  img: HTMLImageElement;
}

/** Resolve a tool's `attachment` / `path` into a loaded image. */
export async function resolveImage(input: { attachment?: string; path?: string }): Promise<PlacedImage> {
  let name: string, dataUrl: string;
  if (input.attachment) {
    const a = store.get(input.attachment);
    if (!a) throw new Error(`There's no attachment “${input.attachment}”.${store.size ? ` Attached: ${[...store.keys()].join(', ')}.` : ' Nothing has been attached.'}`);
    if (!a.mime.startsWith('image/')) throw new Error(`${a.id} is a PDF, not an image. Recreate its design with the editor's tools instead.`);
    name = a.name;
    dataUrl = a.dataUrl;
  } else if (input.path) {
    const ext = extOf(input.path);
    if (!IMAGE_MIME[ext]) throw new Error('That isn’t an image file (PNG, JPEG, GIF, WebP, BMP or SVG).');
    const f = await api.readFile(input.path).catch(() => null);
    if (!f) throw new Error(`Couldn’t read ${input.path}.`);
    name = f.name;
    dataUrl = await toDataUrl(new Blob([f.data as BlobPart], { type: IMAGE_MIME[ext] }));
  } else throw new Error('Give `attachment` (an id like "a1") or `path`.');
  const img = await loadImage(dataUrl);
  // SVGs and other formats the editors can't store directly become PNG.
  if (!/^data:image\/(png|jpeg|gif|webp)/.test(dataUrl)) {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || 1024;
    c.height = img.naturalHeight || 1024;
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    dataUrl = c.toDataURL('image/png');
  }
  return { name, dataUrl, width: img.naturalWidth || 1024, height: img.naturalHeight || 1024, img };
}
