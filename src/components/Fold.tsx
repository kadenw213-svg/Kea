// The one folding section every screen uses (logic and saved choices: src/lib/folds.ts). Put a screen's sections in a
// <FoldGroup screen="…">: the first one showing starts open, the rest start closed, and each remembers being opened or
// closed. A closed section that holds something overdue or an error still shows its count on the header (`alert`).
import { createContext, ReactNode, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { foldAlert, isFoldOpen, openByDefault, useFolds } from '../lib/folds';

interface Group {
  screen: string;
  order: string[];
  register(id: string, el: Element): () => void;
}
const GroupCtx = createContext<Group | null>(null);

/** The sections of one screen, in the order they show. */
export function FoldGroup({ screen, children }: { screen: string; children: ReactNode }) {
  const els = useRef(new Map<string, Element>());
  const [order, setOrder] = useState<string[]>([]);
  const sync = useCallback(() => {
    const list = [...els.current]
      .filter(([, e]) => e.isConnected)
      .sort(([, a], [, b]) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
      .map(([id]) => id);
    setOrder((prev) => (prev.length === list.length && prev.every((x, i) => x === list[i]) ? prev : list));
  }, []);
  const register = useCallback(
    (id: string, el: Element) => {
      els.current.set(id, el);
      sync();
      return () => {
        if (els.current.get(id) === el) els.current.delete(id);
        sync();
      };
    },
    [sync]
  );
  const value = useMemo(() => ({ screen, order, register }), [screen, order, register]);
  return <GroupCtx.Provider value={value}>{children}</GroupCtx.Provider>;
}

/**
 * A section's place in its screen's order. Also for a section that isn't a <Fold> but should count as the screen's
 * first (an assignment guide's steps): put the returned ref on it.
 */
export function useFoldPlace(id: string) {
  const group = useContext(GroupCtx);
  const [el, setEl] = useState<Element | null>(null);
  const register = group?.register;
  useLayoutEffect(() => (el && register ? register(id, el) : undefined), [el, id, register]);
  return { ref: setEl, group, first: group ? openByDefault(group.order, id) : undefined };
}

/** One section's open state, remembered per screen and section. */
export function useFold(screen: string, section: string, byDefault: boolean): [boolean, (open: boolean) => void] {
  const choices = useFolds((s) => s.choices);
  const open = isFoldOpen(choices, screen, section, byDefault);
  const set = useCallback((o: boolean) => useFolds.getState().set(screen, [[section, o]]), [screen, section]);
  return [open, set];
}

/** The count (or "!") a closed section's header keeps showing. */
export function FoldAlert({ open, alert, tone = 'danger' }: { open: boolean; alert?: number | boolean | string | null; tone?: 'danger' | 'warn' }) {
  const text = foldAlert(open, alert);
  if (!text) return null;
  return (
    <span className={`fold-alert ${tone}`} title={text === '!' ? 'Something here needs you' : `${text} need${text === '1' ? 's' : ''} you`}>
      {text}
    </span>
  );
}

export interface FoldProps {
  /** Its name on this screen (kept with the choice: keep it the same when the title's count changes). */
  id: string;
  title: ReactNode;
  children: ReactNode;
  /** Without a FoldGroup around it. */
  screen?: string;
  /** Overrides "first open, the rest closed" (an Advanced section is always closed until opened). */
  defaultOpen?: boolean;
  /** Overdue or failed things inside: their count, or true for an error. Shown on the header while it's closed. */
  alert?: number | boolean | string | null;
  alertTone?: 'danger' | 'warn';
  className?: string;
  /** Buttons on the header's right that don't fold it. */
  actions?: ReactNode;
  /** `details`: the browser's own <details>/<summary> (the inside stays in the page while closed). */
  as?: 'section' | 'details';
}

export function Fold({ id, title, children, screen, defaultOpen, alert, alertTone, className = '', actions, as = 'section' }: FoldProps) {
  const place = useFoldPlace(id);
  const where = screen || place.group?.screen || 'kea';
  const [open, setOpen] = useFold(where, id, defaultOpen ?? place.first ?? true);
  if (as === 'details')
    return (
      <details
        ref={place.ref}
        className={`fold ${className}`}
        open={open}
        onToggle={(e) => {
          const now = (e.currentTarget as HTMLDetailsElement).open;
          if (now !== open) setOpen(now);
        }}
      >
        <summary>
          {title}
          <FoldAlert open={open} alert={alert} tone={alertTone} />
        </summary>
        {children}
      </details>
    );
  return (
    <section ref={place.ref} className={`fold ${open ? 'open' : ''} ${className}`}>
      <div className="fold-head">
        <button className="fold-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRight size={15} className="fold-chev" />
          <span className="fold-title">{title}</span>
          <FoldAlert open={open} alert={alert} tone={alertTone} />
        </button>
        {actions && <div className="fold-actions">{actions}</div>}
      </div>
      {open && <div className="fold-body">{children}</div>}
    </section>
  );
}
