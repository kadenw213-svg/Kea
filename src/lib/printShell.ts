// Printing always happens on white paper, whatever theme Kea is in.
// Dark mode can leave light text colors inside a document (text written while the page was dark). On white paper
// that text would vanish, so print drops a near-white text color unless the same element sets its own background.

/** A color's brightness from 0 (black) to 1 (white), or null when it isn't a plain color we can read. */
export function brightness(value: string): number | null {
  const v = value.trim().toLowerCase();
  if (v === 'white') return 1;
  let m = /^#([0-9a-f]{3})$/.exec(v);
  let r: number, g: number, b: number;
  if (m) {
    [r, g, b] = m[1].split('').map((c) => parseInt(c + c, 16));
  } else if ((m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(v))) {
    r = parseInt(m[1].slice(0, 2), 16);
    g = parseInt(m[1].slice(2, 4), 16);
    b = parseInt(m[1].slice(4, 6), 16);
  } else if ((m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(v))) {
    r = +m[1];
    g = +m[2];
    b = +m[3];
  } else return null;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** Removes near-white `color:` values from inline styles that have no background of their own. */
export function dropLightText(html: string): string {
  return html.replace(/\bstyle="([^"]*)"/gi, (whole, css: string) => {
    if (/background/i.test(css)) return whole;
    const next = css.replace(/(^|;)\s*color\s*:\s*([^;]+)/gi, (decl, lead: string, value: string) => {
      const b = brightness(value);
      return b !== null && b > 0.82 ? lead : decl;
    });
    if (next === css) return whole;
    const cleaned = next.replace(/;{2,}/g, ';').replace(/^;/, '').replace(/;\s*$/, '').trim();
    return cleaned ? `style="${cleaned}"` : '';
  });
}
