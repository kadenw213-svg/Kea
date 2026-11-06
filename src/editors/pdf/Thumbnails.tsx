import { memo, useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from './pdfjs';
import type { PageRef } from './types';
import { scheduleRender } from './renderQueue';

interface ThumbProps {
  doc: PDFDocumentProxy | null;
  pageRef: PageRef;
  rotation: number;
  aspect: number; // height / width
  number: number;
  selected: boolean;
  current: boolean;
  root: HTMLElement | null;
  onMouseDown(e: React.MouseEvent): void;
  onContextMenu(e: React.MouseEvent): void;
  onDragStart(e: React.DragEvent): void;
  onDragOver(e: React.DragEvent): void;
  onDrop(e: React.DragEvent): void;
  dropBefore: boolean;
  dropAfter: boolean;
}

const THUMB_W = 132;

const Thumb = memo(function Thumb(p: ThumbProps) {
  const ref = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { root: p.root, rootMargin: '400px 0px' });
    if (ref.current) io.observe(ref.current);
    return () => io.disconnect();
  }, [p.root]);

  useEffect(() => {
    if (!visible || !p.doc || !canvasRef.current) return;
    let task: any;
    let cancelled = false;
    const cancelJob = scheduleRender(50 + p.number, async () => {
      if (cancelled) return;
      const page = await p.doc!.getPage(p.pageRef.index + 1);
      if (cancelled) return;
      const vp1 = page.getViewport({ scale: 1, rotation: p.rotation });
      const s = (THUMB_W * 2) / vp1.width;
      const vp = page.getViewport({ scale: s, rotation: p.rotation });
      const c = canvasRef.current!;
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      task = page.render({ canvasContext: c.getContext('2d')!, viewport: vp });
      try {
        await task.promise;
      } catch {}
    });
    return () => {
      cancelled = true;
      cancelJob();
      task?.cancel();
    };
  }, [visible, p.doc, p.pageRef.index, p.rotation]);

  return (
    <div
      ref={ref}
      className={`thumb ${p.selected ? 'selected' : ''} ${p.current ? 'current' : ''} ${p.dropBefore ? 'drop-before' : ''} ${p.dropAfter ? 'drop-after' : ''}`}
      draggable
      onMouseDown={p.onMouseDown}
      onContextMenu={p.onContextMenu}
      onDragStart={p.onDragStart}
      onDragOver={p.onDragOver}
      onDrop={p.onDrop}
    >
      <div className="thumb-img" style={{ width: THUMB_W, height: THUMB_W * p.aspect }}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: p.doc ? 'block' : 'none' }} />
      </div>
      <div className="thumb-num">{p.number}</div>
    </div>
  );
});

interface Props {
  /** Dark pages are on: the thumbnails are darkened the same way. */
  dark?: boolean;
  pages: PageRef[];
  docs: (PDFDocumentProxy | null)[];
  sizeOf(ref: PageRef): { width: number; height: number; rotation: number };
  selected: Set<string>;
  currentIndex: number;
  onSelect(sel: Set<string>, clickedIndex: number): void;
  onReorder(ids: string[], toIndex: number): void;
  onContextMenu(e: React.MouseEvent, index: number): void;
}

export function Thumbnails({ pages, docs, sizeOf, selected, currentIndex, onSelect, onReorder, onContextMenu, dark }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const anchor = useRef(0);
  const [drop, setDrop] = useState<{ index: number; after: boolean } | null>(null);
  const dragIds = useRef<string[] | null>(null);

  useEffect(() => setRoot(rootRef.current), []);

  // Keep the current page's thumbnail in view.
  useEffect(() => {
    const el = rootRef.current?.children[currentIndex] as HTMLElement | undefined;
    if (!el || !rootRef.current) return;
    const r = rootRef.current;
    if (el.offsetTop < r.scrollTop || el.offsetTop + el.offsetHeight > r.scrollTop + r.clientHeight) {
      r.scrollTo({ top: el.offsetTop - r.clientHeight / 2 + el.offsetHeight / 2, behavior: 'smooth' });
    }
  }, [currentIndex]);

  const handleMouseDown = (e: React.MouseEvent, i: number) => {
    if (e.button !== 0 && selected.has(pages[i].id)) return;
    const id = pages[i].id;
    let next: Set<string>;
    if (e.shiftKey) {
      const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
      next = new Set(pages.slice(a, b + 1).map((p) => p.id));
    } else if (e.ctrlKey || e.metaKey) {
      next = new Set(selected);
      next.has(id) ? next.delete(id) : next.add(id);
      anchor.current = i;
    } else {
      next = selected.has(id) && selected.size > 1 && e.button === 0 ? selected : new Set([id]);
      anchor.current = i;
    }
    onSelect(next, i);
  };

  return (
    <div className={`thumbs ${dark ? 'dark' : ''}`} ref={rootRef} onDragLeave={(e) => e.currentTarget === e.target && setDrop(null)}>
      {pages.map((p, i) => {
        const s = sizeOf(p);
        return (
          <Thumb
            key={p.id}
            doc={p.src >= 0 ? docs[p.src] : null}
            pageRef={p}
            rotation={s.rotation}
            aspect={s.height / s.width}
            number={i + 1}
            selected={selected.has(p.id)}
            current={i === currentIndex}
            root={root}
            onMouseDown={(e) => handleMouseDown(e, i)}
            onContextMenu={(e) => {
              e.preventDefault();
              onContextMenu(e, i);
            }}
            onDragStart={(e) => {
              dragIds.current = selected.has(p.id) ? pages.filter((x) => selected.has(x.id)).map((x) => x.id) : [p.id];
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('application/x-kea-page', '1');
            }}
            onDragOver={(e) => {
              if (!dragIds.current) return;
              e.preventDefault();
              e.stopPropagation();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              setDrop({ index: i, after: e.clientY > r.top + r.height / 2 });
            }}
            onDrop={(e) => {
              if (!dragIds.current) return;
              e.preventDefault();
              e.stopPropagation();
              if (drop) onReorder(dragIds.current, drop.index + (drop.after ? 1 : 0));
              dragIds.current = null;
              setDrop(null);
            }}
            dropBefore={!!drop && drop.index === i && !drop.after}
            dropAfter={!!drop && drop.index === i && drop.after}
          />
        );
      })}
    </div>
  );
}
