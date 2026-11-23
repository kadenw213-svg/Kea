// The Claude panel's Usage menu (Kea 0.101): your plan's limits (on the Claude plan) and the approximate tokens Kea's
// features used on your Claude, today, over 7 days and over 30 days, with an API-equivalent cost estimate
// (electron/usageTally.cjs). Also where sharing those counts with Kea's developer is turned off.
import { useEffect, useState } from 'react';
import { Gauge } from 'lucide-react';
import { MenuButton } from '../Popover';
import { api, type UsageSummary } from '../../lib/api';
import { useSettings } from '../../lib/settings';
import { toast } from '../../store';

const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)));
const money = (n: number) => (n < 0.01 ? '<$0.01' : `$${n < 10 ? n.toFixed(2) : Math.round(n)}`);
const NAMES: Record<string, string> = {
  'home.chat': 'Claude pages (Home)',
  'study.teach': 'Study lessons',
  'assistant.doc': 'Documents',
  'assistant.sheet': 'Spreadsheets',
  'assistant.slides': 'Presentations',
  'assistant.pdf': 'PDFs',
  'assistant.image': 'Photos',
  'assistant.video': 'Video',
  'assistant.code': 'Code'
};
const nameOf = (f: string) => NAMES[f] || (f.startsWith('scholar.') ? `School: ${f.slice(8).replace(/[_-]/g, ' ')}` : f.replace(/[._-]/g, ' '));

export function UsageMenu({ onPlan, showBars }: { onPlan: boolean; showBars: boolean }) {
  return (
    <MenuButton
      align="right"
      title="Usage"
      button={(open) => (
        <button className={`icon-btn sm ${open ? 'on' : ''}`}>
          <Gauge size={15} />
        </button>
      )}
    >
      {() => <UsageBody onPlan={onPlan} showBars={showBars} />}
    </MenuButton>
  );
}

function UsageBody({ onPlan, showBars }: { onPlan: boolean; showBars: boolean }) {
  const [days, setDays] = useState(1);
  const [sum, setSum] = useState<UsageSummary | null>(null);
  const sharing = useSettings((s) => s.values['privacy.shareUsage']) !== false;
  useEffect(() => {
    api.usage?.summary(days).then(setSum).catch(() => setSum(null));
  }, [days]);
  const t = sum?.total;
  const tokens = t ? t.input + t.output + t.cacheRead + t.cacheWrite : 0;
  const feats = sum ? Object.entries(sum.byFeature).sort((a, b) => b[1].cost - a[1].cost).slice(0, 7) : [];
  return (
    <div className="usage-menu">
      <div className="menu-title">Usage</div>
      {onPlan && (
        <label className="usage-check">
          <input type="checkbox" checked={showBars} onChange={(e) => useSettings.getState().set({ 'assistant.usageBars': e.target.checked })} /> Show my plan’s 5-hour and weekly limits
        </label>
      )}
      <div className="usage-tabs">
        {[
          [1, 'Today'],
          [7, '7 days'],
          [30, '30 days']
        ].map(([d, label]) => (
          <button key={d} className={days === d ? 'on' : ''} onClick={() => setDays(d as number)}>
            {label}
          </button>
        ))}
      </div>
      {!sum ? (
        <div className="menu-note">Loading…</div>
      ) : !tokens ? (
        <div className="menu-note">Kea hasn’t used your Claude {days === 1 ? 'today' : `in the last ${days} days`}.</div>
      ) : (
        <>
          <div className="usage-big">
            <span>
              <b>{fmt(tokens)}</b> tokens
            </span>
            <span className="muted" title="What the same tokens would cost on Claude’s API at list prices. On a Claude plan you don’t pay this: it’s for comparing.">
              ≈ {money(t!.cost)} at API prices
            </span>
          </div>
          <div className="usage-sub muted">
            {fmt(t!.input + t!.cacheWrite)} in · {fmt(t!.cacheRead)} re-read · {fmt(t!.output)} out · {t!.calls} {t!.calls === 1 ? 'run' : 'runs'}
          </div>
          <div className="usage-rows">
            {feats.map(([f, v]) => {
              const share = t!.cost ? v.cost / t!.cost : 0;
              return (
                <div key={f} className="usage-row" title={`${fmt(v.input + v.output + v.cacheRead + v.cacheWrite)} tokens over ${v.calls} ${v.calls === 1 ? 'run' : 'runs'}`}>
                  <span className="usage-name">{nameOf(f)}</span>
                  <span className="usage-bar">
                    <i style={{ width: `${Math.max(3, share * 100)}%` }} />
                  </span>
                  <span className="usage-val">{money(v.cost)}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
      <div className="menu-sep" />
      <div className="usage-share">
        <label className="usage-check">
          <input type="checkbox" checked={sharing} onChange={(e) => useSettings.getState().set({ 'privacy.shareUsage': e.target.checked })} /> Share these counts with Kea’s developer
        </label>
        <div className="menu-note">Only counts, feature and tool names: never your prompts, files or answers. It helps make Kea’s tools cheaper to run.</div>
        {!sharing && (
          <button
            className="btn sm"
            onClick={async () => {
              const r = await api.usage.forget();
              toast(r.ok ? 'Deleted what Kea had sent.' : 'Sign in to your Kea account to delete what was sent.', r.ok ? 'success' : 'error');
            }}
          >
            Delete what was sent
          </button>
        )}
      </div>
    </div>
  );
}
