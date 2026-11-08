// Pay codes in Work (the org engine's paycodes.mjs): a code is a job's pay rate. Everyone sees My pay on the Time tab
// (their codes and rates, their default, hours per code for a pay period, the timecard totals and, when the server
// has them, their pay stubs) and picks among their own codes on their shifts and when clocking in. With
// paycodes.manage: the organization's codes (People → Pay codes). With paycodes.assign: giving people codes and their
// default (People → Edit). Rates show only to those with rates.view (or paycodes.manage); everyone else sees names.
// Nobody is ever shown a code they weren't given unless they manage, give or schedule codes.
import { useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, Star, Trash2, X } from 'lucide-react';
import { ask } from '../../store';
import { act, addDays, fmtDay, useHub } from './workStore';
import { Advanced, Card, Field, Loading, Num, Problem } from './ui';
import { can } from './types';
import type { Member, Org, Shift, Structure } from './types';
import { centsOf, codeLabel, grantable, hasChoice, keepsHistory, pickable, pickedCode, rateText, seesRates, shiftChoices, stubCents, stubsOf } from './payRules';
import type { MyPay, PayCode, PayCodeList, PersonCode } from './payRules';

const hrs = (min: number) => `${Math.round((min / 60) * 100) / 100} h`;
const money = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const Dot = ({ color }: { color: string | null }) => <span className="pc-dot" style={color ? { background: color } : undefined} />;

/** My pay: everything about my pay the server assigned to me. Nothing at all when there's nothing to show. */
export function MyPayCard({ org }: { org: Org }) {
  const [start, setStart] = useState<string | null>(null);
  const d = useHub<MyPay>(`/v1/orgs/${org.id}/me/pay${start ? `?periodStart=${start}` : ''}`);
  // (A server without pay codes answers 404: then there's no My pay.)
  if (d.error || !d.data) return null;
  const my = d.data;
  const codes = my.codes ?? [];
  const stubs = stubsOf(my);
  if (!codes.length && !my.hours?.length && !stubs) return null;
  const len = Math.round((Date.parse(my.period.end) - Date.parse(my.period.start)) / 864e5) + 1;
  const t = my.totals;
  return (
    <Card
      title="My pay"
      actions={
        <span className="wk-inline">
          <button className="icon-btn sm" title="Earlier pay period" onClick={() => setStart(addDays(my.period.start, -len))}>
            <ChevronLeft size={15} />
          </button>
          {fmtDay(my.period.start, { month: 'short', day: 'numeric' })} – {fmtDay(my.period.end, { month: 'short', day: 'numeric' })}
          <button className="icon-btn sm" title="Later pay period" onClick={() => setStart(addDays(my.period.start, len))}>
            <ChevronRight size={15} />
          </button>
        </span>
      }
    >
      {codes.length > 0 && (
        <div className="pc-mine">
          {codes.map((c) => (
            <span key={c.id} className={`pc-code ${c.active ? '' : 'wk-dim'}`}>
              <Dot color={c.color} />
              {codeLabel(c, true)}
              {c.default && <span className="wk-pill sm">Default</span>}
            </span>
          ))}
        </div>
      )}
      {my.hours?.length > 0 && (
        <table className="wk-table pc-hours">
          <tbody>
            {my.hours.map((x) => (
              <tr key={x.codeId ?? 'none'}>
                <td>
                  <Dot color={x.color} /> {x.name ?? 'No pay code'}
                  {x.noLongerGiven && <span className="muted"> (no longer yours)</span>}
                </td>
                <td className="num">{hrs(x.minutes)}</td>
                <td className="num muted">{x.rateCents != null ? rateText(x.rateCents) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="af-small">
        <b>{hrs(t.workedMin)}</b> worked
        {t.overtimeMin ? `, ${hrs(t.regularMin)} regular, ${hrs(t.overtimeMin)} overtime` : ''}
        {t.doubleTimeMin ? `, ${hrs(t.doubleTimeMin)} double time` : ''}
        {my.approved ? ' · Approved' : ''}
      </p>
      {stubs && (
        <>
          <h4 className="pc-sub">Pay stubs</h4>
          {stubs.map((s, i) => {
            const net = stubCents(s, 'net');
            const gross = stubCents(s, 'gross');
            const when = s.payDate ?? s.date ?? s.periodEnd;
            return (
              <div key={s.id ?? i} className="wk-row">
                <span className="wk-row-main">
                  <span className="wk-row-title">{when ? `Paid ${fmtDay(when)}` : 'Pay stub'}</span>
                  {s.periodStart && s.periodEnd && (
                    <span className="wk-row-sub">
                      {fmtDay(s.periodStart, { month: 'short', day: 'numeric' })} – {fmtDay(s.periodEnd, { month: 'short', day: 'numeric' })}
                      {s.hours != null ? ` · ${s.hours} h` : ''}
                    </span>
                  )}
                </span>
                {gross != null && <span className="muted">{money(gross)} gross</span>}
                {net != null && <b>{money(net)}</b>}
              </div>
            );
          })}
        </>
      )}
    </Card>
  );
}

/** A choice among my own codes (or, for a manager, among someone's codes). Only those codes, never any other. */
export function CodePicker({ codes, value, onChange, disabled, title = 'Pay code' }: { codes: PersonCode[]; value: string; onChange(id: string): void; disabled?: boolean; title?: string }) {
  return (
    <select className="input sm wk-auto pc-pick" value={value} title={title} disabled={disabled} onChange={(e) => e.target.value && onChange(e.target.value)}>
      {!value && <option value="">Pay code…</option>}
      {codes.map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

/** The pay code on one of my shifts: a picker when I have a choice, the code's name when I have one code. */
export function MyShiftCode({ org, shift, my }: { org: Org; shift: Shift; my: MyPay | null }) {
  const codes = pickable(my);
  if (!codes.length || shift.payCodeId === undefined) return null;
  const value = pickedCode(codes, shift.payCodeId, my?.defaultCodeId);
  if (!hasChoice(codes)) return <span className="muted af-small">{codes[0].name}</span>;
  return <CodePicker codes={codes} value={value} onChange={(id) => id !== value && act(`/v1/orgs/${org.id}/shifts/${shift.id}/pay-code`, { payCodeId: id }, 'Pay code changed.')} />;
}

/** A manager setting the code on someone's shift: only that person's own codes. */
export function ShiftCodeBar({ org, shift, onDone }: { org: Org; shift: Shift; onDone(): void }) {
  const theirs = useHub<{ codes: PersonCode[] }>(shift.accountId ? `/v1/orgs/${org.id}/members/${shift.accountId}/pay-codes` : null);
  const choices = shiftChoices(theirs.data?.codes);
  const value = pickedCode(choices, shift.payCodeId);
  return (
    <div className="pc-bar">
      <span className="wk-row-main">
        <span className="wk-row-title">
          Pay code for {shift.name ?? 'this shift'}, {fmtDay(shift.date)}
        </span>
        {theirs.data && !choices.length && <span className="wk-row-sub">They have no pay codes yet. Give them one in People.</span>}
      </span>
      {theirs.error && <Problem error={theirs.error} />}
      {choices.length > 0 && (
        <CodePicker
          codes={choices}
          value={value}
          onChange={async (id) => {
            if (id !== value && (await act(`/v1/orgs/${org.id}/shifts/${shift.id}/pay-code`, { payCodeId: id }, 'Pay code set.'))) onDone();
          }}
        />
      )}
      <button className="icon-btn sm" title="Close" onClick={onDone}>
        <X size={14} />
      </button>
    </div>
  );
}

// ---------- someone's codes (People) ----------
/** May I see this person's codes at all? (Their own; or giving, rates, scheduling or timecards where they work.) */
export const seesTheirCodes = (org: Org, m: Pick<Member, 'you' | 'departmentId'>) =>
  m.you || ['paycodes.assign', 'rates.view', 'schedule.edit', 'timecards.approve'].some((a) => can(org, a, m.departmentId)) || can(org, 'paycodes.manage', null);

/** Someone's codes in a few words, for the People list: rates only with rates.view. */
export function PersonCodes({ org, m }: { org: Org; m: Member }) {
  const theirs = useHub<{ codes: PersonCode[] }>(seesTheirCodes(org, m) ? `/v1/orgs/${org.id}/members/${m.id}/pay-codes` : null);
  const show = m.you || seesRates(org, m.departmentId);
  if (!theirs.data?.codes.length) return <>—</>;
  return (
    <span className="pc-list">
      {theirs.data.codes.map((c) => (
        <span key={c.id} className={`pc-code ${c.active ? '' : 'wk-dim'}`} title={c.default ? 'Their default' : undefined}>
          <Dot color={c.color} />
          {codeLabel(c, show)}
          {c.default && <Star size={11} />}
        </span>
      ))}
    </span>
  );
}

/** In a person's edit panel: their codes, and with paycodes.assign, giving and taking codes and setting the default. */
export function MemberCodes({ org, m }: { org: Org; m: Member }) {
  const assign = can(org, 'paycodes.assign', m.departmentId) && (!m.you || org.role === 'owner');
  const theirs = useHub<{ codes: PersonCode[] }>(seesTheirCodes(org, m) ? `/v1/orgs/${org.id}/members/${m.id}/pay-codes` : null);
  const all = useHub<PayCodeList>(assign ? `/v1/orgs/${org.id}/pay-codes` : null);
  const [pick, setPick] = useState('');
  if (!seesTheirCodes(org, m)) return null;
  const show = m.you || seesRates(org, m.departmentId);
  const codes = theirs.data?.codes ?? [];
  const left = grantable(all.data?.codes ?? [], codes);
  const base = `/v1/orgs/${org.id}/members/${m.id}/pay-codes`;
  return (
    <Field label="Pay codes">
      <div className="wk-tags">
        {!theirs.data && !theirs.error && <Loading />}
        {theirs.data && !codes.length && <span className="muted af-small">None yet.</span>}
        {codes.map((c) => (
          <span key={c.id} className={`pc-code chip ${c.active ? '' : 'wk-dim'}`}>
            <Dot color={c.color} />
            {codeLabel(c, show)}
            {c.default ? (
              <span className="wk-pill sm">Default</span>
            ) : (
              assign && (
                <button className="icon-btn sm" title="Make it their default" onClick={() => act(`${base}/${c.id}/default`, {}, `${c.name} is their default.`)}>
                  <Star size={12} />
                </button>
              )
            )}
            {assign && (
              <button className="icon-btn sm" title="Take this code away" onClick={() => act(`${base}/${c.id}/delete`, {}, 'Taken away. Their shifts still to come move to their default.')}>
                <X size={12} />
              </button>
            )}
          </span>
        ))}
        {assign && left.length > 0 && (
          <span className="wk-inline">
            <select className="input sm wk-auto" value={pick} onChange={(e) => setPick(e.target.value)}>
              <option value="">Give a code…</option>
              {left.map((c) => (
                <option key={c.id} value={c.id}>
                  {codeLabel(c, show)}
                </option>
              ))}
            </select>
            <button className="btn sm" disabled={!pick} onClick={async () => (await act(base, { codeId: pick, default: !codes.length }, 'Given.')) && setPick('')}>
              <Plus size={13} /> Give
            </button>
          </span>
        )}
      </div>
    </Field>
  );
}

// ---------- the organization's codes (People → Pay codes, paycodes.manage) ----------
export function PayCodesAdmin({ org }: { org: Org }) {
  const list = useHub<PayCodeList>(`/v1/orgs/${org.id}/pay-codes`);
  const st = useHub<Structure>(`/v1/orgs/${org.id}/structure`);
  const [name, setName] = useState('');
  const [rate, setRate] = useState<number | null>(null);
  const [color, setColor] = useState('#2a7fff');
  const [dept, setDept] = useState('');
  if (list.error) return <Problem error={list.error} retry={list.reload} />;
  if (!list.data) return <Loading />;
  const history = keepsHistory(list.data.codes);
  const depts = st.data?.departments ?? [];
  return (
    <div className="wk-stack">
      {!list.data.hasKey && <p className="af-info">This server can’t keep pay rates yet. Whoever runs it needs to set it up for pay codes.</p>}
      <Card title="New pay code">
        <div className="wk-form-row">
          <input className="input sm" placeholder="Name, for example Lifeguard" value={name} onChange={(e) => setName(e.target.value)} />
          <label className="wk-inline" title="Pay per hour">
            $<Num value={rate} onChange={setRate} step={0.25} />/h
          </label>
          <button
            className="btn sm primary"
            disabled={!name.trim() || rate == null}
            onClick={async () => {
              if (await act(`/v1/orgs/${org.id}/pay-codes`, { name: name.trim(), rate, color, departmentId: dept || null }, 'Pay code made.')) (setName(''), setRate(null));
            }}
          >
            <Plus size={14} /> Make code
          </button>
        </div>
        <Advanced>
          <div className="wk-form-grid">
            <Field label="Color">
              <input className="input sm pc-color" type="color" value={color} onChange={(e) => setColor(e.target.value)} />
            </Field>
            <Field label="Department" hint="Who may see its rate: rates.view there.">
              <select className="input sm" value={dept} onChange={(e) => setDept(e.target.value)}>
                <option value="">Whole organization</option>
                {depts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </Advanced>
      </Card>
      <Card title="Pay codes">
        {!list.data.codes.length && <p className="muted">No pay codes yet. Make one for each job, for example Lifeguard and Swim instructor.</p>}
        {list.data.codes.map((c) => (
          <CodeRow key={c.id} org={org} c={c} depts={depts} history={history} />
        ))}
      </Card>
    </div>
  );
}

function CodeRow({ org, c, depts, history }: { org: Org; c: PayCode; depts: Structure['departments']; history: boolean }) {
  const [editRate, setEditRate] = useState(false);
  const [rate, setRate] = useState<number | null>(null);
  const [from, setFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [showHistory, setShowHistory] = useState(false);
  const base = `/v1/orgs/${org.id}/pay-codes/${c.id}`;
  const cents = centsOf(c);
  const save = (body: Record<string, unknown>, done?: string) => act(base, body, done);
  return (
    <div className={`pc-row ${c.active ? '' : 'wk-dim'}`}>
      <div className="st-dept">
        <input className="pc-color" type="color" defaultValue={c.color ?? '#888888'} title="Color" onBlur={(e) => e.target.value !== (c.color ?? '#888888') && save({ color: e.target.value })} />
        <input className="input sm st-name" defaultValue={c.name} onBlur={(e) => e.target.value.trim() && e.target.value !== c.name && save({ name: e.target.value.trim() })} />
        <button className="btn link sm" title="Change the rate" onClick={() => (setEditRate(!editRate), setRate(cents == null ? null : cents / 100))}>
          {cents == null ? 'Rate' : rateText(cents)}
        </button>
        <select className="input sm wk-auto" value={c.departmentId ?? ''} title="Department" onChange={(e) => save({ departmentId: e.target.value || null })}>
          <option value="">Whole organization</option>
          {depts.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <span className="muted af-small">{c.holders ? `${c.holders} ${c.holders === 1 ? 'person' : 'people'}` : 'Nobody yet'}</span>
        <button className="btn sm" onClick={() => save({ active: !c.active }, c.active ? `${c.name} is off. Nobody can pick it now.` : `${c.name} is on again.`)}>
          {c.active ? 'Turn off' : 'Turn on'}
        </button>
        <button
          className="icon-btn sm"
          title="Delete (only a code that was never used)"
          onClick={async () => {
            if ((await ask(`Delete ${c.name}?`, 'Only a code that’s on no shifts or punches can be deleted. One that was used can be turned off instead.', [{ id: 'no', label: 'Cancel' }, { id: 'yes', label: 'Delete', danger: true, primary: true }])) === 'yes') act(`${base}/delete`, {}, 'Deleted.');
          }}
        >
          <Trash2 size={14} />
        </button>
      </div>
      {editRate && (
        <div className="wk-form-row pc-rate">
          <label className="wk-inline">
            New rate $<Num value={rate} onChange={setRate} step={0.25} />/h
          </label>
          {history && (
            <label className="wk-inline">
              starting <input className="input sm wk-auto" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
          )}
          <button className="btn sm" onClick={() => setEditRate(false)}>
            Cancel
          </button>
          <button className="btn sm primary" disabled={rate == null} onClick={async () => (await save({ rate, ...(history ? { effectiveFrom: from } : {}) }, 'Rate changed.')) && setEditRate(false)}>
            Save
          </button>
          {history && Array.isArray(c.rateHistory) && c.rateHistory.length > 0 && (
            <button className="btn link sm" onClick={() => setShowHistory(!showHistory)}>
              {showHistory ? 'Hide earlier rates' : 'Earlier rates'}
            </button>
          )}
        </div>
      )}
      {editRate && showHistory && (
        <div className="pc-history">
          {c.rateHistory!.map((h, i) => {
            const hc = centsOf(h);
            return (
              <div key={i} className="muted af-small">
                {hc == null ? '—' : rateText(hc)} from {fmtDay(h.effectiveFrom)}
                {h.effectiveTo ? ` to ${fmtDay(h.effectiveTo)}` : ''}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
