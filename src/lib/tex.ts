// LaTeX drawn with MathJax as SVG, offline. Shared by the document editor's equations and study explanations (on the PC
// and the phone); the engine loads on first use and every drawing is cached.
//
// The LaTeX can come from anyone (a shared question batch, a classmate's document), so it's drawn safely: no `html`
// extension (\href, \style, \class, \cssId, \data), no \require or \setOptions, MathJax's own safe mode (no URLs,
// classes, ids or styles from the TeX), and then the drawing itself is checked before it's turned into markup: only
// SVG's drawing elements, no event handlers, no links but web ones, and no style, class or id except MathJax's own
// baseline on the outer <svg>.

let enginePromise: Promise<{ doc: any; adaptor: any }> | null = null;

/** Packages left out: `html` (links, styles, classes, ids, data attributes), and those that load or reconfigure others. */
const LEFT_OUT = ['bussproofs', 'html', 'require', 'autoload', 'setoptions'];

function engine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const [{ mathjax }, { TeX }, { SVG }, { liteAdaptor }, { RegisterHTMLHandler }, { AllPackages }, { SafeHandler }] = await Promise.all([
        import('mathjax-full/js/mathjax.js'),
        import('mathjax-full/js/input/tex.js'),
        import('mathjax-full/js/output/svg.js'),
        import('mathjax-full/js/adaptors/liteAdaptor.js'),
        import('mathjax-full/js/handlers/html.js'),
        import('mathjax-full/js/input/tex/AllPackages.js'),
        import('mathjax-full/js/ui/safe/SafeHandler.js')
      ]);
      const adaptor = liteAdaptor();
      SafeHandler(RegisterHTMLHandler(adaptor));
      const doc = mathjax.document('', {
        InputJax: new TeX({ packages: AllPackages.filter((p: string) => !LEFT_OUT.includes(p)) }),
        OutputJax: new SVG({ fontCache: 'none' }),
        safeOptions: {
          allow: { URLs: 'none', classes: 'none', cssIDs: 'none', styles: 'none' },
          safeProtocols: { http: true, https: true, file: false, javascript: false, data: false }
        }
      });
      return { doc, adaptor };
    })();
  }
  return enginePromise;
}

/** SVG's drawing elements: all MathJax's SVG output uses. Anything else (foreignObject, script, a stray HTML tag) goes. */
const ELEMENTS = new Set(['svg', 'g', 'path', 'rect', 'line', 'ellipse', 'circle', 'polygon', 'polyline', 'text', 'tspan', 'title', 'desc', 'defs', 'a', 'mjx-container']);
/** The outer <svg>'s own style (its baseline and, for a tagged equation, its width): lengths only. */
const ROOT_STYLE = new Set(['vertical-align', 'min-width', 'max-width', 'width', 'height', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom']);
const LENGTH = /^-?(\d+(\.\d+)?|\.\d+)(ex|em|px|%)?$/;

function rootStyle(style: string) {
  return style
    .split(';')
    .map((d) => d.split(':').map((x) => x.trim().toLowerCase()))
    .filter(([p, v, extra]) => extra === undefined && ROOT_STYLE.has(p) && LENGTH.test(v || ''))
    .map(([p, v]) => `${p}: ${v};`)
    .join(' ');
}

/**
 * Cleans MathJax's drawing (a LiteDOM tree) in place: unknown elements removed; event handlers, style, class and id
 * removed (except the outer <svg>'s length-only style); links kept only for http(s) addresses or places in the drawing.
 */
export function cleanMathTree(adaptor: any, node: any, depth = 0): void {
  const kind = String(adaptor.kind(node));
  if (kind === '#text' || kind === '#comment') return;
  for (const child of [...adaptor.childNodes(node)]) {
    const k = String(adaptor.kind(child));
    if (k === '#text') continue;
    if (k === '#comment' || !ELEMENTS.has(k.toLowerCase())) adaptor.remove(child);
    else cleanMathTree(adaptor, child, depth + 1);
  }
  // (The outer <svg>: the node itself, or the <svg> right inside MathJax's container.)
  const outer = depth === 0 || (depth === 1 && kind === 'svg');
  for (const { name, value } of adaptor.allAttributes(node) as { name: string; value: string }[]) {
    const n = name.toLowerCase();
    const v = String(value ?? '');
    let keep = true;
    if (n.startsWith('on') || n === 'class' || n === 'id' || n === 'tabindex' || n === 'autofocus') keep = false;
    else if (n === 'style') {
      const s = outer && kind === 'svg' ? rootStyle(v) : '';
      if (s) adaptor.setAttribute(node, 'style', s);
      keep = !!s;
    } else if (n === 'href' || n === 'src' || n.endsWith(':href')) {
      keep = /^(https?:\/\/|#)/i.test(v.replace(/[\u0000- \u007f-\u009f]/g, ''));
    } else if (n.startsWith('data-') && !/^data-(mml-node|c|mjx-[a-z-]+|variant|semantic-[a-z-]+)$/.test(n)) keep = false;
    if (!keep) adaptor.removeAttribute(node, name);
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** MathJax's error message, if the drawing is an error (null when it isn't). */
function findError(adaptor: any, node: any): string | null {
  const kind = String(adaptor.kind(node));
  if (kind === '#text' || kind === '#comment') return null;
  const own = adaptor.getAttribute(node, 'data-mjx-error');
  if (own != null) return String(own);
  for (const child of adaptor.childNodes(node)) {
    const e = findError(adaptor, child);
    if (e != null) return e;
  }
  return null;
}

const svgCache = new Map<string, string>();
const key = (tex: string, display: boolean) => `${display ? 'D' : 'I'}:${tex}`;

/** SVG markup for a LaTeX string (cached). Errors come back as a red message instead of throwing. */
export async function texToSvg(tex: string, display = false): Promise<string> {
  const k = key(tex, display);
  const hit = svgCache.get(k);
  if (hit) return hit;
  const { doc, adaptor } = await engine();
  let svg: string;
  try {
    const node = doc.convert(tex || '\\square', { display, em: 16, ex: 8, containerWidth: 1200 });
    const error = findError(adaptor, node);
    if (error != null) svg = `<span class="math-error">${escapeHtml(error || 'Error')}</span>`;
    else {
      cleanMathTree(adaptor, node);
      svg = adaptor.innerHTML(node);
    }
  } catch (err: any) {
    svg = `<span class="math-error">${escapeHtml(String(err?.message || err).slice(0, 80))}</span>`;
  }
  svgCache.set(k, svg);
  return svg;
}
export const cachedSvg = (tex: string, display = false) => svgCache.get(key(tex, display));
