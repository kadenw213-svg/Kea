// Small shared bits of the phone app's interface.

/** A short message at the bottom of the screen, for a few seconds. */
export function toast(e: unknown) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = String((e as any)?.message || e);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

/** "1.2 MB", "340 KB". */
export const size = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

/** "Today 3:40 PM", "Yesterday", "Oct 12". */
export function when(ms: number) {
  const d = new Date(ms);
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(ms).setHours(0, 0, 0, 0)) / 864e5);
  if (days === 0) return `Today ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: days > 300 ? 'numeric' : undefined });
}
