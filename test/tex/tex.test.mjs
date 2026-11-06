// LaTeX from other people (shared question batches, a classmate's document) is drawn by src/lib/tex.ts and inserted as
// markup by the study explanation (PC and phone), the teaching screen and the document editor. None of it may carry a
// script link, an event handler, or styles, classes or ids of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { texToSvg } from '../../src/lib/tex.ts';

const hostile = String.raw`\href{javascript:alert(document.domain)}{x}
\href{https://example.com}{x}
\style{position:fixed;top:0;left:0;width:9999px;height:9999px;background:red}{x}
\class{evil}{x}
\cssId{evil}{x}
\data{onload=alert(1)}{x}
\href{"><img src=x onerror=alert(1)>}{x}
\unicode{<img src=x onerror=alert(1)>}
\require{html}\href{javascript:alert(1)}{x}
\setOptions[html]{}{x}
\mmlToken{mi}[href="javascript:alert(1)"]{x}
\mmlToken{mi}[style="position:fixed;inset:0"]{x}
\mmlToken{mi}[class="x" id="y" onclick="alert(1)"]{x}
\mmlToken{mi}[href="java&#9;script:alert(1)"]{x}
\text{<img src=x onerror=alert(1)>}
\text{</svg><img src=x onerror=alert(1)>}
\color{red}{\colorbox{blue}{x}}`.split('\n');

for (const display of [false, true]) {
  for (const t of hostile) {
    test(`${display ? 'display' : 'inline'}: ${t}`, async () => {
      const svg = await texToSvg(t, display);
      // (Refused: MathJax's message as plain text.)
      if (svg.startsWith('<span class="math-error">')) return assert.match(svg, /^<span class="math-error">[^<>]*<\/span>$/);
      assert.match(svg, /^<svg /);
      assert.doesNotMatch(svg, /javascript:|vbscript:|data:text/i, 'no script links');
      assert.doesNotMatch(svg, /\son[a-z]+\s*=/i, 'no event handlers');
      assert.doesNotMatch(svg, /<(img|script|iframe|foreignObject|style|object|embed)\b/i, 'no HTML or foreign elements');
      assert.doesNotMatch(svg, /\s(class|id)=/i, 'no classes or ids');
      assert.doesNotMatch(svg, /\sdata-(?!mml-node|c=|mjx-)[a-z-]+=/i, 'no data attributes of its own');
      // Only the outer <svg> may have a style, and only MathJax's baseline/width lengths.
      const styles = [...svg.matchAll(/\sstyle="([^"]*)"/g)].map((m) => m[1]);
      assert.ok(styles.length <= 1, `one style at most: ${styles.join(' | ')}`);
      for (const s of styles) assert.match(s, /^((vertical-align|min-width|max-width|width|height|margin-(left|right|top|bottom)): -?[\d.]+(ex|em|px|%)?; ?)*$/, s);
      if (styles.length) assert.match(svg, /^<svg[^>]*\sstyle=/, 'the style is on the outer svg');
      for (const h of svg.matchAll(/href="([^"]*)"/g)) assert.match(h[1], /^(https?:\/\/|#)/, h[1]);
    });
  }
}

test('ordinary math still draws, with its baseline', async () => {
  for (const t of [String.raw`\frac{a}{b}`, String.raw`x^2 + \sqrt{y}`, String.raw`\color{red}{x}`, String.raw`\begin{align}a&=b\\c&=d\end{align}`, String.raw`\ce{H2O}`]) {
    const svg = await texToSvg(t, false);
    assert.match(svg, /^<svg[^>]*style="vertical-align: -?[\d.]+ex;"/, t);
    assert.match(svg, /<path /, t);
  }
  const tagged = await texToSvg(String.raw`\tag{1} x`, true);
  assert.match(tagged, /min-width: [\d.]+ex;/);
  const colored = await texToSvg(String.raw`\color{red}{x}`, false);
  assert.match(colored, /fill="red"/);
});

test('errors are shown as escaped text', async () => {
  const svg = await texToSvg(String.raw`\frac{<img src=x onerror=alert(1)>`, false);
  assert.match(svg, /^<span class="math-error">/);
  assert.doesNotMatch(svg, /<img/);
});
