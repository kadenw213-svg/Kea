import { useEffect, useRef, useState } from 'react';
import { CalendarPlus, Copy, RefreshCw, Link2Off, X } from 'lucide-react';
import { api, type CalendarShareStatus } from '../../lib/api';
import { toast } from '../../store';

const ago = (t: number | null) => {
  if (!t) return 'not yet';
  const m = Math.round((Date.now() - t) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/**
 * Calendar → Share: put the Kea calendar in Google Calendar (or Apple, Outlook) through a private link they subscribe to.
 * Off until turned on; turning it off deletes the copy Kea's account server holds and stops the link.
 */
export function ShareCalendar() {
  const [open, setOpen] = useState(false);
  const [st, setSt] = useState<CalendarShareStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  const run = async (fn: () => Promise<CalendarShareStatus>, fail: string) => {
    setBusy(true);
    try {
      setSt(await fn());
    } catch (err: any) {
      toast(err?.message || fail, 'error');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!open) return;
    api.calendarShare.status().then(setSt).catch(() => {});
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(st!.url!);
      toast('Link copied. In Google Calendar choose Other calendars, then From URL.', 'success');
    } catch {
      toast('Couldn’t copy. Select the link and copy it.', 'error');
    }
  };

  return (
    <div className="share-cal" ref={box}>
      <button className={`btn sm ${st?.enabled ? 'tonal' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} title="Show this calendar in Google Calendar">
        <CalendarPlus size={14} /> Share
      </button>
      {open && (
        <div className="share-pop" role="dialog" aria-label="Share your calendar">
          <div className="share-head">
            <b>Show Kea in Google Calendar</b>
            <button className="icon-btn sm" onClick={() => setOpen(false)} title="Close">
              <X size={14} />
            </button>
          </div>
          {!st ? (
            <p className="muted">Checking…</p>
          ) : !st.signedIn ? (
            <p className="muted">Sign in to your Kea account online first (Settings → Kea account). The link is made by your account server.</p>
          ) : !st.enabled ? (
            <>
              <p>
                Kea makes a private link. Paste it into Google Calendar and your assignments, exams, classes and shifts show up there too. Only people with the link can see it, and you can
                turn it off any time.
              </p>
              <p className="muted">Turning it on sends your calendar’s titles, times, places and links to your Kea account server. Turning it off deletes that copy.</p>
              {st.error && <p className="share-err">{st.error}</p>}
              <button className="btn primary sm" disabled={busy} onClick={() => run(api.calendarShare.on, 'Couldn’t turn sharing on.')}>
                Turn on sharing
              </button>
            </>
          ) : (
            <>
              <input className="input share-url" readOnly value={st.url || ''} onFocus={(e) => e.currentTarget.select()} aria-label="Your private calendar link" />
              <div className="share-row">
                <button className="btn primary sm" onClick={copy} disabled={!st.url}>
                  <Copy size={13} /> Copy link
                </button>
                <button className="btn sm" disabled={busy} onClick={() => run(api.calendarShare.now, 'Couldn’t update.')} title="Send your calendar to the link now">
                  <RefreshCw size={13} /> Update now
                </button>
              </div>
              <p className="muted">
                {st.count} item{st.count === 1 ? '' : 's'} shared · updated {ago(st.updatedAt)}. In Google Calendar: <b>Other calendars → From URL</b>. Google only re-reads a link every several hours, so changes
                show up there later, not at once.
              </p>
              {st.error && <p className="share-err">{st.error}</p>}
              <div className="share-row">
                <button className="btn sm ghost" disabled={busy} onClick={() => run(api.calendarShare.on, 'Couldn’t make a new link.')} title="The old link stops working at once">
                  New link
                </button>
                <button className="btn sm ghost" disabled={busy} onClick={() => run(api.calendarShare.off, 'Couldn’t turn sharing off.')}>
                  <Link2Off size={13} /> Turn off
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
