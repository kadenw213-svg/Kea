// LaTeX drawn with MathJax as SVG, offline. Shared by the document editor's equations and study explanations; the
// engine loads on first use and every drawing is cached.

let enginePromise: Promise<{ doc: any; adaptor: any }> | null = null;
function engine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const [{ mathjax }, { TeX }, { SVG }, { liteAdaptor }, { RegisterHTMLHandler }, { AllPackages }] = await Promise.all([
        import('mathjax-full/js/mathjax.js'),
        import('mathjax-full/js/input/tex.js'),
        import('mathjax-full/js/output/svg.js'),
        import('mathjax-full/js/adaptors/liteAdaptor.js'),
        import('mathjax-full/js/handlers/html.js'),
        import('mathjax-full/js/input/tex/AllPackages.js')
      ]);
      const adaptor = liteAdaptor();
      RegisterHTMLHandler(adaptor);
      const doc = mathjax.document('', {
        InputJax: new TeX({ packages: AllPackages.filter((p: string) => p !== 'bussproofs') }),
        OutputJax: new SVG({ fontCache: 'none' })
      });
      return { doc, adaptor };
    })();
  }
  return enginePromise;
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
    svg = adaptor.innerHTML(node);
    if (/data-mjx-error/.test(svg)) {
      const msg = /data-mjx-error="([^"]*)"/.exec(svg)?.[1] || 'Error';
      svg = `<span class="math-error">${msg}</span>`;
    }
  } catch (err: any) {
    svg = `<span class="math-error">${String(err?.message || err).slice(0, 80)}</span>`;
  }
  svgCache.set(k, svg);
  return svg;
}
export const cachedSvg = (tex: string, display = false) => svgCache.get(key(tex, display));
