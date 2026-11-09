// Highlights in documents: Tiptap's multicolour highlight, drawn so the text on it always reads. The colour the person
// chose is kept exactly (saved to .docx, .html, .md as is); each highlight also says which ink reads on it
// (data-ink, from its lightness), and doc.css picks the text colour from that and the page colour.
import Highlight from '@tiptap/extension-highlight';
import { highlightInk, DEFAULT_HIGHLIGHT } from '../../lib/highlightInk';
import { setting } from '../../lib/settings';

/** The colour a new highlight gets (Settings › Documents), falling back to the soft default. */
export const defaultHighlight = () => String(setting('doc.highlightDefault') || DEFAULT_HIGHLIGHT);

export const DocHighlight = Highlight.extend({
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-color') || element.style.backgroundColor || null,
        renderHTML: (attributes: { color?: string | null }) => {
          if (!attributes.color) return {};
          return {
            'data-color': attributes.color,
            'data-ink': highlightInk(attributes.color),
            style: `background-color: ${attributes.color}`
          };
        }
      }
    };
  },
  addKeyboardShortcuts() {
    // Ctrl+Shift+H: the default colour (not the browser's bright yellow).
    return { 'Mod-Shift-h': () => this.editor.commands.toggleHighlight({ color: defaultHighlight() }) };
  }
}).configure({ multicolor: true });
