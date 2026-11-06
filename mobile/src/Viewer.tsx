// Any file on the phone, opened in Kea: PDFs in the book reader; Word, OpenDocument, RTF, web pages, Markdown and EPUB
// books as a page to read (in the student's font, size and colours, and read aloud); spreadsheets as tables; slides as
// slides; code and text; pictures, sound and video. Each kind's reader is Kea on the PC's own, loaded only when that kind
// is opened. Anything else opens in another app on the phone, and can always be shared.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ExternalLink, Headphones, Pause, Play, Share2, SkipBack, SkipForward, Square, Type, X } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { Kea } from './kea';
import { Book } from './Book';
import { setLook, useLook } from './theme';
import { toast } from './ui';
import { spoken } from './speech';

export type ViewTarget = { file: string; title: string; type?: string; chapter?: string; autoplay?: boolean };
type Kind = 'pdf' | 'doc' | 'epub' | 'sheet' | 'slides' | 'text' | 'markdown' | 'image' | 'audio' | 'video' | 'other';

const EXT: Record<string, Kind> = {
  pdf: 'pdf',
  docx: 'doc', docm: 'doc', dotx: 'doc', doc: 'doc', odt: 'doc', rtf: 'doc', html: 'doc', htm: 'doc', xhtml: 'doc', mht: 'other',
  epub: 'epub',
  xlsx: 'sheet', xlsm: 'sheet', xls: 'sheet', ods: 'sheet', csv: 'sheet', tsv: 'sheet',
  pptx: 'slides', pptm: 'slides', ppsx: 'slides', potx: 'slides',
  md: 'markdown', markdown: 'markdown',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image', svg: 'image', heic: 'image', avif: 'image', ico: 'image',
  mp3: 'audio', m4a: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', aac: 'audio', flac: 'audio', opus: 'audio', weba: 'audio',
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video', mkv: 'video', '3gp': 'video'
};
const TEXT = /^(txt|text|log|json|xml|yaml|yml|ini|cfg|conf|toml|csv|js|mjs|cjs|ts|tsx|jsx|py|java|kt|c|h|cpp|hpp|cs|go|rs|rb|php|swift|sh|bat|ps1|sql|css|scss|tex|bib|srt|vtt)$/;
const extOf = (n: string) => (n.lastIndexOf('.') > 0 ? n.slice(n.lastIndexOf('.') + 1).toLowerCase() : '');
export function kindOf(name: string, type = ''): Kind {
  const e = extOf(name);
  if (EXT[e]) return EXT[e];
  if (TEXT.test(e)) return 'text';
  if (/pdf/.test(type)) return 'pdf';
  if (/^image\//.test(type)) return 'image';
  if (/^audio\//.test(type)) return 'audio';
  if (/^video\//.test(type)) return 'video';
  if (/^text\//.test(type)) return 'text';
  return 'other';
}

const urlOf = (path: string) => Capacitor.convertFileSrc(path);
async function bytesOf(path: string) {
  const r = await fetch(urlOf(path));
  if (!r.ok) throw new Error('Kea couldn’t read this file.');
  return new Uint8Array(await r.arrayBuffer());
}
const textOf = (b: Uint8Array) => new TextDecoder('utf-8').decode(b);

/** A document's HTML, made safe to show: no scripts, frames, event handlers or script links. */
function safe(html: string) {
  const d = new DOMParser().parseFromString(html, 'text/html');
  d.querySelectorAll('script, iframe, frame, object, embed, link, meta, base, form, animate, set').forEach((e) => e.remove());
  // URLs are checked the way the browser reads them (tabs, newlines and control characters dropped), so
  // "java&#9;script:" can't slip through; only web, mail, phone, in-page and inline-image links are kept.
  const unsafeUrl = (v: string) => {
    const u = v.replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase();
    const scheme = /^([a-z][a-z0-9+.-]*):/.exec(u)?.[1];
    return !!scheme && !['http', 'https', 'mailto', 'tel'].includes(scheme) && !/^data:image\/(png|jpe?g|gif|webp);/.test(u);
  };
  d.querySelectorAll('*').forEach((e) => {
    for (const a of [...e.attributes]) if (/^on/i.test(a.name) || (/^(href|src|xlink:href|action|formaction|srcset|poster|background)$/i.test(a.name) && unsafeUrl(a.value))) e.removeAttribute(a.name);
  });
  return d.body.innerHTML;
}

/** Open any file: the right reader for its kind. */
export function Viewer({ target, onClose, onOpen }: { target: ViewTarget; onClose(): void; onOpen?(t: ViewTarget): void }) {
  // (A library chapter's title has no extension; its file does.)
  const kind = kindOf(extOf(target.file) ? target.file : target.title, target.type);
  if (kind === 'pdf') return <Book key={target.file} target={{ file: target.file, chapter: target.chapter || target.title, title: target.title.replace(/\.pdf$/i, ''), autoplay: target.autoplay }} onClose={onClose} onOpen={onOpen} />;
  return <FileView key={target.file} target={target} kind={kind} onClose={onClose} />;
}

function FileView({ target, kind, onClose }: { target: ViewTarget; kind: Kind; onClose(): void }) {
  const look = useLook();
  const [html, setHtml] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [sheets, setSheets] = useState<{ name: string; rows: string[][] }[] | null>(null);
  const [deck, setDeck] = useState<any>(null);
  const [error, setError] = useState('');
  const [opts, setOpts] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const name = target.title || target.file.split('/').pop() || 'File';

  useEffect(() => {
    let live = true;
    (async () => {
      const ext = extOf(name) || extOf(target.file);
      if (kind === 'doc' || kind === 'markdown' || kind === 'epub') {
        const b = await bytesOf(target.file);
        let h = '';
        if (kind === 'markdown') h = (await import('../../src/lib/markdown')).markdownToHtml(textOf(b));
        else if (kind === 'epub') h = await epubToHtml(b);
        else if (ext === 'odt') h = await (await import('../../src/editors/doc/otherFormats')).odtToHtml(b);
        else if (ext === 'rtf') h = (await import('../../src/editors/doc/otherFormats')).rtfToHtml(textOf(b));
        else if (ext === 'doc') h = (await import('../../src/editors/doc/otherFormats')).docToHtml(b);
        else if (/^(html?|xhtml)$/.test(ext)) h = textOf(b);
        else h = await (await import('../../src/editors/doc/docxImport')).docxToHtml(b);
        if (live) setHtml(safe(h));
      } else if (kind === 'sheet') {
        const b = await bytesOf(target.file);
        const io = await import('../../src/editors/sheet/io');
        const m = await import('../../src/editors/sheet/model');
        const wb = await io.readWorkbook(name, b);
        const calc = new m.Calc(wb);
        const out = wb.sheets.map((s) => {
          const u = m.usedRange(s);
          const rows: string[][] = [];
          // (A table to read on a phone: the used part, at most 2000 rows by 60 columns.)
          for (let r = 0; r < Math.min(u.rows, 2000); r++) {
            const row: string[] = [];
            for (let c = 0; c < Math.min(u.cols, 60); c++) {
              const cell = s.cells[m.key(r, c)];
              row.push(cell ? m.formatValue(cell.f ? calc.value(s, r, c) : (cell.v as any), cell.s) : '');
            }
            rows.push(row);
          }
          return { name: s.name, rows };
        });
        if (live) setSheets(out);
      } else if (kind === 'slides') {
        const b = await bytesOf(target.file);
        const d = await (await import('../../src/editors/slides/pptxImport')).readPptx(b);
        if (live) setDeck(d);
      } else if (kind === 'text') {
        const b = await bytesOf(target.file);
        if (live) setText(textOf(b));
      } else if (kind === 'other') {
        // An unknown kind that's really text (no zero bytes near the start) is shown as text.
        const b = await bytesOf(target.file).catch(() => null);
        if (live && b && b.length && !b.subarray(0, 8000).includes(0)) setText(textOf(b));
      }
    })().catch((e) => live && setError(String(e?.message || e) || 'Kea couldn’t open this file.'));
    return () => {
      live = false;
    };
  }, [target.file]);

  const readable = kind === 'doc' || kind === 'markdown' || kind === 'epub' || kind === 'text' || (kind === 'other' && text != null);
  const reader = useReadAloud(body, readable && (html != null || text != null), name);
  const docStyle = { ['--doc-scale' as any]: look.docScale, ['--doc-font' as any]: FONTS[look.docFont] || FONTS.sans, ['--doc-leading' as any]: look.docLeading };

  return (
    <div className="m-overlay vw">
      <div className="bk-top">
        <button className="icon" aria-label="Back" onClick={() => (reader.stop(), onClose())}>
          <ChevronLeft size={22} />
        </button>
        <span className="bk-title">
          <b>{name}</b>
          <span className="muted small block">{LABEL[kind]}</span>
        </span>
        {readable && (
          <button className="icon" aria-label="Text options" onClick={() => setOpts(!opts)}>
            <Type size={20} />
          </button>
        )}
        {readable && (
          <button className={`icon ${reader.on ? 'on' : ''}`} aria-label="Read aloud" onClick={() => (reader.on ? reader.toggle() : reader.start())}>
            <Headphones size={20} />
          </button>
        )}
        <button className="icon" aria-label="Share" onClick={() => Kea.share({ file: target.file, name }).catch(toast)}>
          <Share2 size={19} />
        </button>
      </div>
      <div className={`vw-body vw-k-${kind}`} style={docStyle}>
        {error ? (
          <Other target={target} name={name} why={error} />
        ) : kind === 'image' ? (
          <div className="vw-image">
            <img src={urlOf(target.file)} alt={name} />
          </div>
        ) : kind === 'audio' ? (
          <div className="vw-media">
            <audio src={urlOf(target.file)} controls autoPlay />
          </div>
        ) : kind === 'video' ? (
          <div className="vw-media">
            <video src={urlOf(target.file)} controls playsInline />
          </div>
        ) : kind === 'other' && text == null ? (
          <Other target={target} name={name} />
        ) : readable && html != null ? (
          <article ref={body} className="vw-doc" dangerouslySetInnerHTML={{ __html: html }} />
        ) : text != null ? (
          <div ref={body} className="vw-doc">
            <pre className="vw-text">{text}</pre>
          </div>
        ) : sheets ? (
          <SheetView sheets={sheets} />
        ) : deck ? (
          <SlidesView deck={deck} />
        ) : (
          <div className="spinner bk-msg" />
        )}
      </div>
      {readable && reader.on && <ReadBar r={reader} />}
      {opts && <DocOptions onClose={() => setOpts(false)} />}
    </div>
  );
}

const LABEL: Record<Kind, string> = { pdf: 'PDF', doc: 'Document', epub: 'Book', sheet: 'Spreadsheet', slides: 'Slides', text: 'Text', markdown: 'Document', image: 'Picture', audio: 'Sound', video: 'Video', other: 'File' };
const FONTS: Record<string, string> = { sans: 'system-ui, Roboto, sans-serif', serif: 'Georgia, "Noto Serif", serif', mono: 'ui-monospace, "Roboto Mono", monospace' };

/** Something Kea can't show itself: open it in another app, or share it. */
function Other({ target, name, why }: { target: ViewTarget; name: string; why?: string }) {
  return (
    <div className="vw-other">
      <p>{why ? `Kea couldn’t open “${name}”: ${why}` : `Kea can’t show this kind of file itself yet.`}</p>
      <button className="btn primary" onClick={() => Kea.openWith({ path: target.file }).catch(toast)}>
        <ExternalLink size={16} /> Open in another app
      </button>
      <button className="btn" onClick={() => Kea.share({ file: target.file, name }).catch(toast)}>
        <Share2 size={16} /> Share
      </button>
    </div>
  );
}

function SheetView({ sheets }: { sheets: { name: string; rows: string[][] }[] }) {
  const [i, setI] = useState(0);
  const s = sheets[i];
  const cols = Math.max(0, ...s.rows.map((r) => r.length));
  return (
    <div className="vw-sheet">
      {sheets.length > 1 && (
        <div className="chips">
          {sheets.map((x, k) => (
            <button key={k} className={k === i ? 'on' : ''} onClick={() => setI(k)}>
              {x.name}
            </button>
          ))}
        </div>
      )}
      <div className="vw-grid">
        <table>
          <thead>
            <tr>
              <th />
              {Array.from({ length: cols }, (_, c) => (
                <th key={c}>{colName(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.rows.map((r, k) => (
              <tr key={k}>
                <th>{k + 1}</th>
                {Array.from({ length: cols }, (_, c) => (
                  <td key={c}>{r[c]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
const colName = (c: number): string => (c < 26 ? String.fromCharCode(65 + c) : colName(Math.floor(c / 26) - 1) + String.fromCharCode(65 + (c % 26)));

function SlidesView({ deck }: { deck: any }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [mod, setMod] = useState<any>(null);
  useEffect(() => {
    import('../../src/editors/slides/SlideView').then(setMod);
    const el = box.current;
    if (!el) return;
    const measure = () => setW(el.clientWidth - 24);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = w && deck.w ? w / deck.w : 0;
  return (
    <div className="vw-slides" ref={box}>
      {mod && <style>{mod.SLIDE_CSS}</style>}
      {mod &&
        scale > 0 &&
        deck.slides.map((s: any, i: number) => (
          <figure key={s.id || i} className="vw-fig" style={{ width: deck.w * scale }}>
            <div className="vw-slide" style={{ width: deck.w * scale, height: deck.h * scale }}>
              <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
                <mod.SlideView slide={s} w={deck.w} h={deck.h} font={deck.font} />
              </div>
            </div>
            {s.notes ? <figcaption className="muted small">{s.notes}</figcaption> : null}
          </figure>
        ))}
    </div>
  );
}

/** Font, size and spacing for documents and books. */
function DocOptions({ onClose }: { onClose(): void }) {
  const look = useLook();
  return (
    <div className="bk-sheet">
      <div className="bk-sheet-head">
        <b>Text</b>
        <button className="icon" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
      </div>
      <span className="muted small">Size</span>
      <div className="bk-opts">
        {[0.85, 1, 1.15, 1.3, 1.5, 1.75].map((v) => (
          <button key={v} className={`bk-chip ${look.docScale === v ? 'on' : ''}`} onClick={() => setLook({ docScale: v })}>
            {Math.round(v * 100)}%
          </button>
        ))}
      </div>
      <span className="muted small">Font</span>
      <div className="bk-opts">
        {(
          [
            ['sans', 'Sans'],
            ['serif', 'Serif'],
            ['mono', 'Monospace']
          ] as const
        ).map(([v, l]) => (
          <button key={v} className={`bk-chip ${look.docFont === v ? 'on' : ''}`} style={{ fontFamily: FONTS[v] }} onClick={() => setLook({ docFont: v })}>
            {l}
          </button>
        ))}
      </div>
      <span className="muted small">Line spacing</span>
      <div className="bk-opts">
        {[1.3, 1.5, 1.7, 2].map((v) => (
          <button key={v} className={`bk-chip ${look.docLeading === v ? 'on' : ''}`} onClick={() => setLook({ docLeading: v })}>
            {v}
          </button>
        ))}
      </div>
      <p className="muted small">Colours follow your theme (Settings → Appearance).</p>
    </div>
  );
}

// ---------- Reading a document aloud: block by block, the one being read marked ----------
type Reader = { on: boolean; playing: boolean; at: string; start(): void; toggle(): void; stop(): void; skip(n: number): void };
function useReadAloud(body: React.RefObject<HTMLDivElement>, ready: boolean, title: string): Reader {
  const look = useLook();
  const [state, setState] = useState<{ on: boolean; playing: boolean; at: string }>({ on: false, playing: false, at: '' });
  const blocks = useRef<HTMLElement[]>([]);
  const mine = useRef(false);
  useEffect(() => {
    const sub = Kea.addListener('speech', (p) => {
      if (!mine.current || !p.id.startsWith('d')) return;
      if (p.state === 'stopped' || p.state === 'done' || p.state === 'error') return setState({ on: false, playing: false, at: '' });
      setState({ on: true, playing: p.state === 'playing', at: p.id });
      const el = blocks.current[Number(p.id.slice(1).split(':')[0])];
      document.querySelectorAll('.vw-reading').forEach((e) => e.classList.remove('vw-reading'));
      if (el && look.highlight !== 'off') el.classList.add('vw-reading');
      if (el && look.follow) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
    return () => {
      sub.then((s) => s.remove());
    };
  }, [look.highlight, look.follow]);
  const start = () => {
    const root = body.current;
    if (!root || !ready) return;
    const list = [...root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6, p, li, blockquote, td, th, pre, figcaption, dt, dd')].filter((e) => e.innerText.trim() && !e.querySelector('p, li, h1, h2, h3, h4, h5, h6'));
    blocks.current = list.length ? list : [root];
    // From the first block on screen.
    const top = root.closest('.vw-body')?.getBoundingClientRect().top || 0;
    const from = Math.max(0, blocks.current.findIndex((e) => e.getBoundingClientRect().bottom > top + 10));
    const items = blocks.current.flatMap((e, i) =>
      i < from
        ? []
        : (e.innerText.match(/[^.!?]+(?:[.!?]+["”’)\]]*|$)/g) || [e.innerText])
            .map((t) => spoken(t.trim()))
            .filter(Boolean)
            .map((t, k, all) => ({ id: `d${i}:${k}`, text: t, ...(k === all.length - 1 ? { pause: /^H\d$/.test(e.tagName) ? 600 : 350 } : {}) }))
    );
    if (!items.length) return toast('There’s no text here to read aloud.');
    mine.current = true;
    Kea.readAloud({ items, title, voice: look.voice || undefined, rate: look.rate }).catch(toast);
    setState({ on: true, playing: true, at: items[0].id });
  };
  const control = (action: 'pause' | 'resume' | 'stop' | 'skip', by?: number) => Kea.readControl({ action, by }).catch(() => {});
  return {
    ...state,
    start,
    toggle: () => (control(state.playing ? 'pause' : 'resume'), setState((s) => ({ ...s, playing: !s.playing }))),
    stop: () => {
      if (!mine.current) return;
      control('stop');
      document.querySelectorAll('.vw-reading').forEach((e) => e.classList.remove('vw-reading'));
      setState({ on: false, playing: false, at: '' });
    },
    skip: (n) => control('skip', n)
  };
}

function ReadBar({ r }: { r: Reader }) {
  const look = useLook();
  const speeds = [0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2];
  return (
    <div className="bk-player">
      <div className="bk-controls">
        <button className="icon" aria-label="Back a sentence" onClick={() => r.skip(-1)}>
          <SkipBack size={20} />
        </button>
        <button className="bk-play" aria-label={r.playing ? 'Pause' : 'Play'} onClick={r.toggle}>
          {r.playing ? <Pause size={24} /> : <Play size={24} />}
        </button>
        <button className="icon" aria-label="Forward a sentence" onClick={() => r.skip(1)}>
          <SkipForward size={20} />
        </button>
        <button
          className="bk-chip"
          onClick={() => {
            const rate = speeds[(speeds.indexOf(look.rate) + 1) % speeds.length] || 1;
            setLook({ rate });
            Kea.readControl({ action: 'settings', rate }).catch(() => {});
          }}
        >
          {look.rate}×
        </button>
        <button className="icon" aria-label="Stop reading" onClick={r.stop}>
          <Square size={16} />
        </button>
      </div>
    </div>
  );
}

// ---------- EPUB books ----------
/** An EPUB's chapters in reading order as one page, with its pictures. */
async function epubToHtml(bytes: Uint8Array) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(bytes);
  const xml = (s: string) => new DOMParser().parseFromString(s, 'application/xml');
  const container = await zip.file('META-INF/container.xml')?.async('string');
  const opfPath = container ? xml(container).querySelector('rootfile')?.getAttribute('full-path') || '' : '';
  const opfText = opfPath ? await zip.file(opfPath)?.async('string') : '';
  if (!opfText) throw new Error('This EPUB has no table of contents Kea can read.');
  const opf = xml(opfText);
  const base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
  const items = new Map<string, { href: string; type: string }>();
  opf.querySelectorAll('manifest > item').forEach((i) => items.set(i.getAttribute('id') || '', { href: i.getAttribute('href') || '', type: i.getAttribute('media-type') || '' }));
  const resolve = (from: string, href: string) => {
    const parts = (from.slice(0, from.lastIndexOf('/') + 1) + decodeURIComponent(href.split('#')[0])).split('/');
    const out: string[] = [];
    for (const p of parts) p === '..' ? out.pop() : p && p !== '.' && out.push(p);
    return out.join('/');
  };
  const blobs = new Map<string, string>();
  const chapters: string[] = [];
  for (const ref of opf.querySelectorAll('spine > itemref')) {
    const it = items.get(ref.getAttribute('idref') || '');
    if (!it || !/html/.test(it.type)) continue;
    const path = resolve(base, it.href);
    const src = await zip.file(path)?.async('string');
    if (!src) continue;
    const doc = new DOMParser().parseFromString(src, 'text/html');
    for (const img of doc.querySelectorAll('img, image')) {
      const attr = img.hasAttribute('src') ? 'src' : img.hasAttribute('href') ? 'href' : 'xlink:href';
      const href = img.getAttribute(attr);
      if (!href || /^(data|https?):/.test(href)) continue;
      const p = resolve(path, href);
      if (!blobs.has(p)) {
        const f = zip.file(p);
        if (f) blobs.set(p, URL.createObjectURL(new Blob([await f.async('arraybuffer')])));
      }
      if (blobs.has(p)) {
        img.setAttribute(attr, blobs.get(p)!);
        if (img.tagName.toLowerCase() === 'image') img.setAttribute('href', blobs.get(p)!);
      }
    }
    chapters.push(`<section class="vw-chapter">${doc.body?.innerHTML || ''}</section>`);
  }
  if (!chapters.length) throw new Error('This EPUB has no chapters Kea can read.');
  return chapters.join('');
}

export { FONTS };
export const useKind = (name: string, type?: string) => useMemo(() => kindOf(name, type), [name, type]);
