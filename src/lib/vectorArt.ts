// Vector artwork Claude writes as SVG (gradient backgrounds, grain, illustrations, badges, ornaments), made safe and
// rendered to a sharp PNG so every editor can place it like any picture. Only self-contained drawing survives: no
// scripts, event handlers, external images, fonts or links.

const DROP = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'audio', 'video', 'canvas', 'a', 'animate', 'set', 'animatemotion', 'animatetransform', 'discard']);
const MAX_SOURCE = 400_000; // characters
const MAX_EDGE = 4096; // pixels of the rendered picture

/** Clean an SVG Claude wrote; throws with a reason Claude can act on. */
export function safeSvg(source: string): { svg: string; width: number; height: number } {
  const src = String(source || '').trim();
  if (!src.startsWith('<svg') && !src.startsWith('<?xml')) throw new Error('svg must be a complete <svg …>…</svg> document.');
  if (src.length > MAX_SOURCE) throw new Error(`That SVG is ${Math.round(src.length / 1000)} KB; keep it under ${MAX_SOURCE / 1000} KB (use patterns and filters instead of thousands of shapes).`);
  const doc = new DOMParser().parseFromString(src, 'image/svg+xml');
  const err = doc.querySelector('parsererror');
  if (err) throw new Error(`The SVG isn't valid XML: ${(err.textContent || '').split('\n').find((l) => l.trim()) || 'parse error'}`.slice(0, 300));
  const root = doc.documentElement;
  if (root.nodeName.toLowerCase() !== 'svg') throw new Error('The outer element must be <svg>.');
  const walk = (el: Element) => {
    for (const child of Array.from(el.children)) {
      if (DROP.has(child.nodeName.toLowerCase())) {
        child.remove();
        continue;
      }
      walk(child);
    }
    for (const a of Array.from(el.attributes)) {
      const n = a.name.toLowerCase();
      const v = a.value;
      if (n.startsWith('on')) el.removeAttribute(a.name);
      // Links only to things inside this drawing (#id); embedded raster data is allowed for <image>.
      else if ((n === 'href' || n === 'xlink:href') && !v.startsWith('#') && !(el.nodeName.toLowerCase() === 'image' && /^data:image\/(png|jpeg|gif|webp);/i.test(v))) el.removeAttribute(a.name);
      else if (/url\(\s*['"]?\s*[^#'"\s)]/i.test(v) || /javascript:|@import/i.test(v)) el.removeAttribute(a.name);
    }
    if (el.nodeName.toLowerCase() === 'style' && /@import|url\(\s*['"]?\s*[^#'"\s)]/i.test(el.textContent || '')) el.textContent = '';
  };
  walk(root);
  // <use> can multiply a drawing exponentially (uses of uses): keep it to what real artwork needs.
  if (root.getElementsByTagName('use').length > 400) throw new Error('That SVG has more than 400 <use> references; draw repeated motifs with <pattern> instead.');
  // Size: the viewBox (what Claude drew in), else width/height.
  const vb = (root.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  let width = vb.length === 4 && vb[2] > 0 ? vb[2] : parseFloat(root.getAttribute('width') || '');
  let height = vb.length === 4 && vb[3] > 0 ? vb[3] : parseFloat(root.getAttribute('height') || '');
  if (!(width > 0 && height > 0)) throw new Error('Give the <svg> a viewBox (e.g. viewBox="0 0 612 792"), sized like the box it will fill.');
  if (vb.length !== 4) root.setAttribute('viewBox', `0 0 ${width} ${height}`);
  if (!root.getAttribute('xmlns')) root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return { svg: new XMLSerializer().serializeToString(root), width, height };
}

/** Render a (cleaned) SVG to a PNG at `scale` × its size, capped so the long edge stays under MAX_EDGE pixels. */
export async function renderSvg(source: string, scale = 3): Promise<{ dataUrl: string; width: number; height: number; img: HTMLImageElement }> {
  const { svg, width, height } = safeSvg(source);
  const s = Math.min(scale, MAX_EDGE / Math.max(width, height));
  const pw = Math.max(1, Math.round(width * s));
  const ph = Math.max(1, Math.round(height * s));
  // Render at the target pixel size so filters and strokes are drawn sharp (not scaled up afterwards).
  const root = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
  root.setAttribute('width', String(pw));
  root.setAttribute('height', String(ph));
  const sized = new XMLSerializer().serializeToString(root);
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error('The SVG couldn’t be drawn. Check that every element and attribute is valid SVG.'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sized)}`;
  });
  const c = document.createElement('canvas');
  c.width = pw;
  c.height = ph;
  c.getContext('2d')!.drawImage(img, 0, 0, pw, ph);
  const dataUrl = c.toDataURL('image/png');
  const out = new Image();
  out.src = dataUrl;
  await out.decode().catch(() => {});
  return { dataUrl, width, height, img: out };
}
