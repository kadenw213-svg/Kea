import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronsRight, ChevronsUp } from 'lucide-react';

/**
 * Keeps an editor's toolbar usable when the window is narrow. Placed in a toolbar just before its `.tb-end` group.
 *  1. First the Encyclopedia and Claude buttons shrink to icons.
 *  2. Then tools are tucked away from the right: the ones after the spacer (mode, find…) before the formatting tools,
 *     the formatting tools last-first.
 *  3. A » button shows everything (the toolbar opens to a second row) and « folds it again.
 * Works on the toolbar's own DOM with data attributes (React leaves those alone), so each editor only adds <ToolbarFit />.
 */
export function ToolbarFit() {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const fitRef = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const btn = ref.current;
    const bar = btn?.parentElement;
    if (!btn || !bar) return;
    let raf = 0;
    const over = () => bar.scrollWidth > bar.clientWidth + 1;
    const fit = () => {
      raf = 0;
      const kids = Array.from(bar.children) as HTMLElement[];
      kids.forEach((k) => k.removeAttribute('data-tb-hidden'));
      bar.removeAttribute('data-tb-compact');
      if (openRef.current) {
        bar.setAttribute('data-tb-open', '');
        btn.style.display = '';
        return;
      }
      bar.removeAttribute('data-tb-open');
      btn.style.display = 'none';
      if (!over()) return;
      bar.setAttribute('data-tb-compact', '');
      if (!over()) return;
      btn.style.display = '';
      const tool = (k: HTMLElement) => k !== btn && !k.classList.contains('tb-end') && !k.classList.contains('tb-spacer') && !k.classList.contains('tb-sep');
      const spacer = kids.findIndex((k) => k.classList.contains('tb-spacer'));
      const left = kids.filter((k, i) => tool(k) && (spacer < 0 || i < spacer));
      const right = kids.filter((k, i) => tool(k) && spacer >= 0 && i > spacer);
      // Never hide the very first tools (undo/redo or the panel toggle): keep at least two.
      const order = [...right.reverse(), ...left.slice(2).reverse()];
      for (const k of order) {
        if (!over()) break;
        k.setAttribute('data-tb-hidden', '');
      }
      // A separator with nothing visible after it (before the next separator) goes too.
      kids.forEach((k, i) => {
        if (!k.classList.contains('tb-sep')) return;
        let j = i + 1;
        while (j < kids.length && kids[j].hasAttribute('data-tb-hidden')) j++;
        if (j >= kids.length || kids[j].classList.contains('tb-sep') || kids[j] === btn || kids[j].classList.contains('tb-spacer')) k.setAttribute('data-tb-hidden', '');
      });
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(fit);
    };
    fitRef.current = fit;
    fit();
    const ro = new ResizeObserver(schedule);
    ro.observe(bar);
    const mo = new MutationObserver(schedule);
    mo.observe(bar, { childList: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
      cancelAnimationFrame(raf);
      bar.removeAttribute('data-tb-open');
      bar.removeAttribute('data-tb-compact');
    };
  }, []);

  // Re-fit right away when opened or folded.
  useLayoutEffect(() => fitRef.current(), [open]);

  return (
    <button
      ref={ref}
      className="icon-btn tb-more"
      title={open ? 'Fewer tools' : 'More tools'}
      aria-label={open ? 'Fewer tools' : 'More tools'}
      aria-expanded={open}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => setOpen((o) => !o)}
    >
      {open ? <ChevronsUp size={18} /> : <ChevronsRight size={18} />}
    </button>
  );
}
