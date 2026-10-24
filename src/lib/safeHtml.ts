// Formatting HTML that Claude writes into a file (a slide's text box): only text formatting survives, never scripts,
// event handlers, links to elsewhere or embedded objects.
const TAGS = new Set(['P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'SPAN', 'UL', 'OL', 'LI', 'SUP', 'SUB', 'DIV']);
const STYLES = new Set(['color', 'background-color', 'font-size', 'font-weight', 'font-style', 'font-family', 'text-decoration', 'text-align', 'line-height', 'letter-spacing', 'text-transform', 'margin-top', 'margin-bottom']);

export function safeFormatHtml(html: string): string {
  const root = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html').body.firstElementChild as HTMLElement;
  const clean = (n: Element) => {
    for (const child of Array.from(n.children)) {
      if (!TAGS.has(child.tagName)) {
        // Unknown elements keep their text (headings become bold paragraphs); dangerous ones go entirely.
        if (['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'svg', 'SVG', 'IMG', 'VIDEO', 'AUDIO', 'LINK', 'META'].includes(child.tagName)) child.remove();
        else {
          const heading = /^H[1-6]$/.test(child.tagName);
          const repl = document.createElement(heading ? 'p' : 'span');
          repl.innerHTML = heading ? `<b>${child.innerHTML}</b>` : child.innerHTML;
          child.replaceWith(repl);
          clean(repl);
        }
        continue;
      }
      const style = (child as HTMLElement).style;
      const keep: string[] = [];
      for (let i = 0; i < style.length; i++) {
        const k = style[i];
        const v = style.getPropertyValue(k);
        if (STYLES.has(k) && !/url\(|expression/i.test(v)) keep.push(`${k}:${v}`);
      }
      for (const a of Array.from(child.attributes)) child.removeAttribute(a.name);
      if (keep.length) child.setAttribute('style', keep.join(';'));
      clean(child);
    }
  };
  clean(root);
  return root.innerHTML;
}
