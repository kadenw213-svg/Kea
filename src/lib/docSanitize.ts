// Shared by Kea on the PC (document previews) and on the phone (mobile/src/sanitize.ts re-exports it).
// A document's HTML (Word, OpenDocument, RTF, a web page, Markdown, an EPUB book), made safe to show inside Kea: it
// comes from any app's "Open with" or "Share", or a class attachment, so it's treated as hostile. DOMPurify cleans it
// and hands back DOM nodes, which are inserted as they are (never turned back into a string and parsed again, which is
// how mutation XSS gets past a sanitizer). Kept: text, formatting, tables, lists, pictures and SVG drawings, web links.
// Gone: scripts, event handlers, forms, frames, plugins, MathML, SVG foreignObject and animation, <style> sheets, and
// any address that isn't a web, mail or phone link (pictures may also be inline data or the book's own blobs).
import DOMPurify from 'dompurify';

const FORBID_TAGS = [
  'script', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal', 'fencedframe',
  'form', 'input', 'button', 'textarea', 'select', 'option', 'optgroup', 'datalist', 'output', 'keygen', 'fieldset',
  'link', 'meta', 'base', 'style', 'dialog', 'slot',
  'math', 'foreignobject', 'foreignObject', 'animate', 'animateMotion', 'animateTransform', 'animatecolor', 'set', 'use', 'mpath', 'discard', 'handler', 'listener'
];
const FORBID_ATTR = ['action', 'formaction', 'srcset', 'ping', 'background', 'poster', 'lowsrc', 'dynsrc', 'srcdoc', 'data', 'codebase', 'manifest', 'is', 'xmlns:xlink', 'attributename', 'to', 'from', 'values', 'by'];

/** Links a reader may follow: the web, email, phone numbers, and places in the same document. */
const LINK = /^(?:https?:|mailto:|tel:|#)/i;
/** Pictures: on the web, the book's own pictures (blob:), and inline pictures in a raster format. */
const PICTURE = /^(?:https?:|blob:|data:image\/(?:png|jpe?g|gif|webp|bmp|avif);)/i;
// (Addresses as the browser reads them: tabs, newlines and control characters don't count, so "java&#9;script:"
// is still a script address.)
const squash = (v: string) => v.replace(/[\u0000- \u007f-\u009f]/g, '');

// A style attribute is read by the browser's own CSS parser (on an element of an inert document, so nothing loads), and
// only these properties, read back from what it parsed, are kept: a page's text can have color, weight and spacing, but
// can't lay itself over Kea's screens or load anything. Reading the parsed result means CSS escapes ("fi\78 ed"),
// comments and odd spacing are already undone: there's no spelling of position:fixed that gets past this.
const COLOR = /^(?:#[0-9a-f]{3,8}|rgba?\([\d.,\s%/]+\)|[a-z]+)$/i;
const WORD = /^[a-z]+(?: [a-z]+)*$/i;
const WEIGHT = /^(?:[a-z]+|\d{1,4})$/i;
const LENGTH = /^(?:0|\d{1,4}(?:\.\d+)?(?:px|pt|pc|em|rem|ex|ch|cm|mm|in|%))$/i;
const SPACE = (v: string) => v === 'auto' || LENGTH.test(v);
const test = (re: RegExp) => (v: string) => re.test(v);
const SAFE_STYLE: Record<string, (v: string) => boolean> = {
  color: test(COLOR),
  'background-color': test(COLOR),
  'font-weight': test(WEIGHT),
  'font-style': test(WORD),
  // (Headings keep their size, within reason; neither of these can lift text out of the page.)
  'font-size': test(/^(?:\d{1,2}(?:\.\d+)?(?:px|pt)|[0-5](?:\.\d+)?r?em|\d{1,3}(?:\.\d+)?%)$/i),
  'line-height': test(/^(?:normal|[0-3](?:\.\d+)?|\d{1,2}(?:\.\d+)?(?:px|pt)|[0-3](?:\.\d+)?r?em|\d{1,3}(?:\.\d+)?%)$/i),
  'text-decoration': test(WORD),
  'text-decoration-line': test(WORD),
  'text-decoration-style': test(WORD),
  'text-decoration-color': test(COLOR),
  'text-align': test(WORD),
  'margin-top': SPACE,
  'margin-right': SPACE,
  'margin-bottom': SPACE,
  'margin-left': SPACE,
  'padding-top': test(LENGTH),
  'padding-right': test(LENGTH),
  'padding-bottom': test(LENGTH),
  'padding-left': test(LENGTH),
  // (A drawing's own colors.)
  fill: test(COLOR),
  stroke: test(COLOR),
  'stroke-width': test(LENGTH)
};
let parser: HTMLElement | null = null;
/** The style attribute's safe part, as CSS the browser itself wrote out; '' when nothing in it is safe. */
function safeStyle(value: string): string {
  parser ??= document.implementation.createHTMLDocument('').createElement('div');
  parser.setAttribute('style', value);
  const parsed = parser.style;
  const kept: string[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const name = parsed[i].toLowerCase();
    const v = parsed.getPropertyValue(name).trim();
    // (A shorthand like `background: url(...)` also sets its other parts to `initial`: nothing worth keeping.)
    if (/^(?:initial|unset|revert|revert-layer)$/i.test(v) || !Object.prototype.hasOwnProperty.call(SAFE_STYLE, name) || !SAFE_STYLE[name](v)) continue;
    kept.push(`${name}: ${v}`);
  }
  parser.removeAttribute('style');
  return kept.join('; ');
}

let hooked = false;
function hook() {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
    const name = data.attrName.toLowerCase();
    const tag = node.nodeName.toLowerCase();
    if (/^on/.test(name)) data.keepAttr = false;
    else if (name === 'href' || name === 'xlink:href') {
      const v = squash(data.attrValue);
      // (An SVG <image> or a picture link inside a drawing is a picture; any other href is a link.)
      data.keepAttr = tag === 'image' ? PICTURE.test(v) : LINK.test(v);
    } else if (name === 'src') {
      data.keepAttr = (tag === 'img' || tag === 'image') && PICTURE.test(squash(data.attrValue));
    } else if (name === 'style') {
      // Formatting stays; a page can't lay itself over Kea's own screens or load things through CSS.
      const css = safeStyle(data.attrValue);
      if (css) data.attrValue = css;
      else data.keepAttr = false;
    }
  });
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    // (Web links never pass on where they came from or a handle on Kea's window.)
    if (node.nodeName.toLowerCase() === 'a' && node.hasAttribute('href')) node.setAttribute('rel', 'noopener noreferrer');
  });
}

/** The document, cleaned, as nodes ready to insert (owned by this page's document). */
export function safeFragment(html: string): DocumentFragment {
  hook();
  return DOMPurify.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    FORBID_TAGS,
    FORBID_ATTR,
    // DOMPurify's own address check (it applies to every attribute), plus blob: for an EPUB's pictures. The stricter
    // rules for links and pictures are in the hook above.
    ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|sms|cid|xmpp|matrix|blob):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    ALLOW_DATA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    SANITIZE_DOM: true,
    SANITIZE_NAMED_PROPS: true,
    KEEP_CONTENT: true,
    WHOLE_DOCUMENT: false
  }) as DocumentFragment;
}
