import { Node, mergeAttributes } from '@tiptap/core';
import { loadImage } from '../../lib/util';

/**
 * Equations written in LaTeX, drawn with MathJax as SVG (offline). Rendered SVGs are cached so print,
 * PDF and Word export (as crisp images with the LaTeX kept as alt text) can reuse them.
 */

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

/** Rasterise an equation for Word (PNG at 3× for print quality), sized like the text around it. */
export async function texToPng(tex: string, display: boolean, fontPx: number): Promise<{ data: Uint8Array; w: number; h: number } | null> {
  const svg = await texToSvg(tex, display);
  if (!svg.startsWith('<svg')) return null;
  const ex = fontPx * 0.45;
  const wEx = parseFloat(/width="([\d.]+)ex"/.exec(svg)?.[1] || '0');
  const hEx = parseFloat(/height="([\d.]+)ex"/.exec(svg)?.[1] || '0');
  if (!wEx || !hEx) return null;
  const w = Math.max(1, Math.round(wEx * ex));
  const h = Math.max(1, Math.round(hEx * ex));
  const scale = 3;
  const sized = svg.replace(/width="[\d.]+ex"/, `width="${w * scale}"`).replace(/height="[\d.]+ex"/, `height="${h * scale}"`).replace(/currentColor/g, '#000');
  const img = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(sized.includes('xmlns=') ? sized : sized.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')));
  const canvas = document.createElement('canvas');
  canvas.width = w * scale;
  canvas.height = h * scale;
  canvas.getContext('2d')!.drawImage(img, 0, 0);
  const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('render failed'))), 'image/png'));
  return { data: new Uint8Array(await blob.arrayBuffer()), w, h };
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    math: {
      insertMath: (latex: string, display?: boolean) => ReturnType;
    };
  }
}

export const MathNode = Node.create({
  name: 'math',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      latex: { default: '', parseHTML: (el) => el.getAttribute('data-math') || '', renderHTML: (a) => ({ 'data-math': a.latex }) },
      display: { default: false, parseHTML: (el) => el.hasAttribute('data-display'), renderHTML: (a) => (a.display ? { 'data-display': '' } : {}) }
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-math]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    // Print/PDF/HTML swap in the cached SVG; the LaTeX is the fallback text.
    return ['span', mergeAttributes(HTMLAttributes, { class: `math${node.attrs.display ? ' display' : ''}` }), node.attrs.latex];
  },
  addStorage() {
    return { onEdit: null as null | ((pos: number) => void) };
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('span');
      dom.className = `math${node.attrs.display ? ' display' : ''}`;
      dom.contentEditable = 'false';
      let cur = { latex: node.attrs.latex, display: node.attrs.display };
      const draw = () => {
        const hit = cachedSvg(cur.latex, cur.display);
        if (hit) dom.innerHTML = hit;
        else {
          dom.textContent = cur.latex || '□';
          const want = { ...cur };
          texToSvg(want.latex, want.display).then((svg) => {
            if (want.latex === cur.latex && want.display === cur.display) dom.innerHTML = svg;
          });
        }
      };
      draw();
      dom.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos != null) (editor.storage as any).math.onEdit?.(pos);
      });
      return {
        dom,
        update: (n) => {
          if (n.type.name !== 'math') return false;
          if (n.attrs.latex !== cur.latex || n.attrs.display !== cur.display) {
            cur = { latex: n.attrs.latex, display: n.attrs.display };
            dom.className = `math${cur.display ? ' display' : ''}`;
            draw();
          }
          return true;
        }
      };
    };
  },
  addCommands() {
    return {
      insertMath:
        (latex, display = false) =>
        ({ chain }) =>
          chain().insertContent({ type: 'math', attrs: { latex, display } }).run()
    };
  }
});

/** Replace math placeholders in exported HTML with their SVGs. */
export function inlineMathSvgs(html: string): string {
  const box = document.createElement('div');
  box.innerHTML = html;
  box.querySelectorAll('span[data-math]').forEach((el) => {
    const svg = cachedSvg(el.getAttribute('data-math') || '', el.hasAttribute('data-display'));
    if (svg) el.innerHTML = svg;
  });
  return box.innerHTML;
}

/** Make sure every equation in a document has been drawn (before printing or exporting). */
export async function renderAllMath(json: any) {
  const jobs: Promise<string>[] = [];
  const walk = (n: any) => {
    if (n.type === 'math') jobs.push(texToSvg(n.attrs?.latex || '', !!n.attrs?.display));
    (n.content || []).forEach(walk);
  };
  walk(json);
  await Promise.all(jobs);
}

/** Buttons in the equation editor: [label, LaTeX to insert]. */
export const MATH_SNIPPETS: { group: string; items: [string, string][] }[] = [
  {
    group: 'Structures',
    items: [
      ['a/b', '\\frac{a}{b}'],
      ['x²', 'x^{2}'],
      ['xᵢ', 'x_{i}'],
      ['√x', '\\sqrt{x}'],
      ['ⁿ√x', '\\sqrt[n]{x}'],
      ['Σ', '\\sum_{i=1}^{n}'],
      ['∫', '\\int_{a}^{b}'],
      ['lim', '\\lim_{x \\to \\infty}'],
      ['( )', '\\left( x \\right)'],
      ['|x|', '\\left| x \\right|'],
      ['vec', '\\vec{v}'],
      ['matrix', '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}'],
      ['cases', 'f(x) = \\begin{cases} 1 & x > 0 \\\\ 0 & x \\le 0 \\end{cases}'],
      ['log', '\\log_{b}(x)'],
      ['sin', '\\sin(\\theta)']
    ]
  },
  {
    group: 'Symbols',
    items: [
      ['±', '\\pm'],
      ['×', '\\times'],
      ['÷', '\\div'],
      ['·', '\\cdot'],
      ['≠', '\\neq'],
      ['≈', '\\approx'],
      ['≤', '\\le'],
      ['≥', '\\ge'],
      ['∞', '\\infty'],
      ['→', '\\to'],
      ['⇒', '\\Rightarrow'],
      ['∈', '\\in'],
      ['∂', '\\partial'],
      ['∇', '\\nabla'],
      ['°', '^{\\circ}'],
      ['∴', '\\therefore']
    ]
  },
  {
    group: 'Greek',
    items: [
      ['α', '\\alpha'],
      ['β', '\\beta'],
      ['γ', '\\gamma'],
      ['δ', '\\delta'],
      ['Δ', '\\Delta'],
      ['ε', '\\epsilon'],
      ['θ', '\\theta'],
      ['λ', '\\lambda'],
      ['μ', '\\mu'],
      ['π', '\\pi'],
      ['ρ', '\\rho'],
      ['σ', '\\sigma'],
      ['Σ', '\\Sigma'],
      ['φ', '\\phi'],
      ['ω', '\\omega'],
      ['Ω', '\\Omega']
    ]
  }
];
