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
      const v = squash(data.attrValue.toLowerCase()).replace(/\\/g, '');
      if (/position:(fixed|sticky)|expression\(|url\(|@import|behavior:|-moz-binding/.test(v)) data.keepAttr = false;
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
