import { useEffect, useState } from 'react';
import { Briefcase, ChevronRight, Wallet } from 'lucide-react';
import { useWork, loadWork, w, openWork, fmtDay, fmtTime, Shift, can } from './workStore';

/** Home's Work card: the next shift and a way into the time clock; for payroll, the pay run. */
export function HomeWork({ payroll }: { payroll: boolean }) {
  const { status, me, positions, tick } = useWork();
  const [next, setNext] = useState<Shift | null | undefined>(undefined);
  const [late, setLate] = useState(0);

  useEffect(() => {
    if (status === null) loadWork();
  }, [status]);
  useEffect(() => {
    if (status !== 'ready' || !me) return;
    const from = new Date();
    const to = new Date(from.getTime() + 8 * 86400e3);
    w<any>('GET', `/v1/shifts?from=${from.toISOString()}&to=${to.toISOString()}`)
      .then((r) => {
        const list: Shift[] = Array.isArray(r) ? r : r?.shifts || [];
        setNext(list.filter((s) => s.personId === me.id && new Date(s.end) > new Date()).sort((a, b) => a.start.localeCompare(b.start))[0] || null);
      })
      .catch(() => setNext(null));
    if (can(me, 'manager'))
      w<any>('GET', '/v1/alerts')
        .then((r) => setLate((Array.isArray(r) ? r : r?.alerts || []).length))
        .catch(() => setLate(0));
  }, [status, me?.id, tick]);

  const pos = (id?: string) => positions.find((p) => p.id === id)?.name || '';

  return (
    <section className="home-work">
      <div className="section-head">
        <h2>Work</h2>
      </div>
      <div className="home-work-cards">
        <button className="home-work-card" onClick={() => openWork('today')}>
          <Briefcase size={20} />
          <span className="home-work-text">
            {status === 'offline' ? (
              <>
                <strong>Work server isn’t reachable</strong>
                <span className="muted">Open Work to try again.</span>
              </>
            ) : status === 'signedOut' ? (
              <>
                <strong>Sign in to your workplace</strong>
                <span className="muted">See your schedule and clock in.</span>
              </>
            ) : next ? (
              <>
                <strong>
                  Next shift: {fmtDay(next.start)}, {fmtTime(next.start)}–{fmtTime(next.end)}
                </strong>
                <span className="muted">{pos(next.positionId)} · open to clock in</span>
              </>
            ) : (
              <>
                <strong>No shifts this week</strong>
                <span className="muted">Open your schedule.</span>
              </>
            )}
          </span>
          <ChevronRight size={18} />
        </button>
        {late > 0 && (
          <button className="home-work-card warn" onClick={() => openWork('today')}>
            <span className="home-work-text">
              <strong>
                {late} {late === 1 ? 'person is' : 'people are'} late or missing
              </strong>
              <span className="muted">See who’s on today</span>
            </span>
            <ChevronRight size={18} />
          </button>
        )}
        {payroll && can(me, 'payroll') && (
          <button className="home-work-card" onClick={() => openWork('pay')}>
            <Wallet size={20} />
            <span className="home-work-text">
              <strong>Pay run</strong>
              <span className="muted">Approve timecards and preview pay</span>
            </span>
            <ChevronRight size={18} />
          </button>
        )}
      </div>
    </section>
  );
}
