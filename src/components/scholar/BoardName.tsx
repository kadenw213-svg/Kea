// How someone shows on Kea Hub class leaderboards: their name, a nickname, or hidden. Kept apart from HubClasses so
// Settings can show it without loading the class pages.
import { useEffect, useState } from 'react';
import { hubc, BoardShow } from '../../lib/hubClasses';
import { HubResult } from '../../lib/api';
import { toast } from '../../store';
import { useHubStatus, refreshHub } from './HubAccount';

async function run<T>(p: Promise<HubResult<T>>): Promise<T | null> {
  const r = await p;
  if (r.ok) return r.value;
  toast(r.error, 'error');
  return null;
}

export function BoardChoice({ show, nick, setShow, setNick }: { show: BoardShow; nick: string; setShow(s: BoardShow): void; setNick(n: string): void }) {
  return (
    <div className="acct-form">
      <div className="st-seg">
        {(
          [
            ['name', 'My name'],
            ['nickname', 'A nickname'],
            ['hidden', 'Hidden'],
          ] as [BoardShow, string][]
        ).map(([v, l]) => (
          <button key={v} className={show === v ? 'on' : ''} onClick={() => setShow(v)}>
            {l}
          </button>
        ))}
      </div>
      {show === 'nickname' && (
        <label>
          <span>Nickname</span>
          <input value={nick} onChange={(e) => setNick(e.target.value)} maxLength={30} placeholder="What others see" />
        </label>
      )}
      <p className="muted hubc-small">
        {show === 'hidden' ? 'Others don’t see you on leaderboards or in the class list; instructors still see who’s in the class. You still see your own rank.' : show === 'nickname' ? 'Others see the nickname instead of your name.' : 'Others in the class see the name on your Kea account.'}
      </p>
    </div>
  );
}

/** Settings → Kea account: one choice for every class. */
export function BoardNameSetting() {
  const status = useHubStatus();
  const cur = status?.me?.account.leaderboard ?? status?.cached?.leaderboard ?? null;
  const [show, setShow] = useState<BoardShow>(cur?.show || 'name');
  const [nick, setNick] = useState(cur?.nickname || '');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (cur) (setShow(cur.show), setNick(cur.nickname || ''));
  }, [cur?.show, cur?.nickname]);
  if (!status?.signedIn) return <p className="muted">Sign in to your Kea account to choose how you show on class leaderboards.</p>;
  return (
    <div>
      <BoardChoice show={show} nick={nick} setShow={setShow} setNick={setNick} />
      <div className="acct-actions hubc-gap">
        <button
          className="btn sm primary"
          disabled={busy || (show === 'nickname' && !nick.trim()) || !status.reachable}
          onClick={async () => {
            setBusy(true);
            const s = await run(hubc.setBoard(show, nick.trim() || null, true));
            setBusy(false);
            if (s) (await refreshHub(), toast('Saved for every class.', 'success'));
          }}
        >
          Save for every class
        </button>
      </div>
    </div>
  );
}
