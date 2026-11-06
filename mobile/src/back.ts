// The phone's Back button: whatever opened last closes first (a book, a quiz, an item's sheet, a class, a sub-screen),
// one step per press. MainActivity asks window.keaBack(); with nothing open it returns false and Kea goes to the
// background.
import { useEffect, useRef } from 'react';

const stack: { id: number; close: () => void }[] = [];
let next = 1;

(window as any).keaBack = () => {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  return true;
};

/** While `open` is true, Back calls `close` (the most recently opened thing closes first). */
export function useBack(open: boolean, close: () => void) {
  const fn = useRef(close);
  fn.current = close;
  useEffect(() => {
    if (!open) return;
    const id = next++;
    stack.push({ id, close: () => fn.current() });
    return () => {
      const i = stack.findIndex((e) => e.id === id);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [open]);
}
