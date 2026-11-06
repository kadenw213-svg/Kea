export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

export function textToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function bytesToText(b: Uint8Array): string {
  // Strip a UTF-8 BOM, fall back to latin1 for files that are not valid UTF-8.
  try {
    const t = new TextDecoder('utf-8', { fatal: true }).decode(b);
    return t.charCodeAt(0) === 0xfeff ? t.slice(1) : t;
  } catch {
    return new TextDecoder('latin1').decode(b);
  }
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function timeAgo(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} day${d > 1 ? 's' : ''} ago`;
  return new Date(ts).toLocaleDateString();
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export async function blobToBytes(b: Blob): Promise<Uint8Array> {
  return new Uint8Array(await b.arrayBuffer());
}

export function bytesToDataUrl(bytes: Uint8Array, mime: string): Promise<string> {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.readAsDataURL(new Blob([bytes as BlobPart], { type: mime }));
  });
}

export function dataUrlToBytes(url: string): Uint8Array {
  const b64 = url.split(',')[1] || '';
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function isMac() {
  return window.api?.platform === 'darwin';
}

export function modKey(e: KeyboardEvent | React.KeyboardEvent) {
  return isMac() ? e.metaKey : e.ctrlKey;
}

/** Load an image and wait until it can be drawn (load event; more reliable than img.decode() for SVGs). */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image could not be loaded'));
    img.src = src;
  });
}
