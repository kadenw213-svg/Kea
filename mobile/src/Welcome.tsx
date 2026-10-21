// Starting Kea: a short tour of what it does, then the choice to connect classes or just use the scanner and PDFs.
// Connecting is its own few steps (Kea on the PC, its files from the drive, the class site, notifications), and the
// settings page holds all of it afterwards.
import { useEffect, useState } from 'react';
import { BookOpen, Bell, Brain, CalendarDays, Check, CheckCircle2, ChevronLeft, ChevronRight, Circle, Cloud, ExternalLink, FileText, FolderOpen, GraduationCap, Inbox, Laptop, Loader2, RefreshCw, ScanLine, School, Smartphone, Upload } from 'lucide-react';
import { Kea } from './kea';
import type { DriveFrom } from './kea';
import { AUTO, checkForUpdate, installUpdate, useUpdate } from './update';
import { toast } from './ui';
import { ACCENT_LIST, PAGES, PageId, THEME_LIST, setLook, useLook } from './theme';
import { VoiceSheet } from './Book';

type NativeState = Awaited<ReturnType<typeof Kea.state>>;
const DOWNLOAD = 'https://github.com/kadenw213-svg/Kea/releases/latest';

/** The drives Kea on the PC can sync through, with where Kea's files are in each and its name in Android's picker. */
const DRIVES = [
  { id: 'google', label: 'Google Drive', app: 'com.google.android.apps.docs', menu: 'Drive', where: 'My Drive → Kea → School' },
  { id: 'onedrive', label: 'OneDrive', app: 'com.microsoft.skydrive', menu: 'OneDrive', where: 'Kea → School' },
  { id: 'dropbox', label: 'Dropbox', app: 'com.dropbox.android', menu: 'Dropbox', where: 'Kea → School' },
  { id: 'phone', label: 'A folder on this phone', app: '', menu: '', where: '' }
] as const;
type DriveId = (typeof DRIVES)[number]['id'];
const DRIVE = 'kea.drive';
/** Where chosen files came from, in words. */
export const placeName = (from?: DriveFrom) => (from === 'phone' ? 'this phone' : from === 'downloads' ? 'Downloads' : from === 'other' ? 'another app' : DRIVES.find((d) => d.id === from)?.label || '');

/** The first start: what Kea is, how it's used, and whether to connect classes now. */
export function Welcome({ onTools, onConnect }: { onTools(): void; onConnect(): void }) {
  const [page, setPage] = useState(0);
  const pages = [
    <>
      <div className="hero-mark">K</div>
      <h1 className="hero-t">Welcome to Kea</h1>
      <p className="hero-p">A scanner, a PDF reader and, if you want it, your whole class schedule and study tools in one app.</p>
    </>,
    <>
      <h1 className="hero-t">Use it right away</h1>
      <div className="feature">
        <ScanLine size={24} />
        <span>
          <b>Scan</b>
          <span>Point at a page. Kea finds the edges, straightens and cleans it, and makes a PDF you can share or save.</span>
        </span>
      </div>
      <div className="feature">
        <FileText size={24} />
        <span>
          <b>PDFs</b>
          <span>Open any PDF from your phone or drive. Kea keeps your scans and PDFs together, ready to read or send.</span>
        </span>
      </div>
      <p className="hero-p small">No account, nothing to set up. Your files stay on your phone.</p>
    </>,
    <>
      <h1 className="hero-t">Add your classes</h1>
      <p className="hero-p">With Kea on your computer set up for your classes, your phone gets everything too:</p>
      <ul className="perks">
        <li>
          <CalendarDays size={18} /> Every due date, class and test, with what’s done and what’s missing
        </li>
        <li>
          <BookOpen size={18} /> Your textbook chapters, readable offline
        </li>
        <li>
          <Brain size={18} /> Practice exams, flashcards and review that sync with your computer
        </li>
        <li>
          <Inbox size={18} /> Announcements, grades and messages, with notifications
        </li>
        <li>
          <Upload size={18} /> Scan your work and hand it in to the right assignment
        </li>
      </ul>
      <p className="hero-p small">You can connect now or any time later from Settings.</p>
    </>
  ];
  const last = page === pages.length - 1;
  return (
    <div className="welcome">
      <div className="welcome-body">{pages[page]}</div>
      <div className="dots">
        {pages.map((_, i) => (
          <i key={i} className={i === page ? 'on' : ''} />
        ))}
      </div>
      <div className="welcome-foot">
        {last ? (
          <>
            <button className="btn primary big" onClick={onConnect}>
              <GraduationCap size={18} /> Connect my classes
            </button>
            <button className="btn big" onClick={onTools}>
              Not now, just scan and read
            </button>
          </>
        ) : (
          <>
            <button className="btn primary big" onClick={() => setPage(page + 1)}>
              Next <ChevronRight size={18} />
            </button>
            <button className="btn ghost" onClick={onTools}>
              Skip
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Connecting classes, step by step. Each step says why it's needed; only Kea's files are required. */
export function PairFlow({ state, onDone, onCancel }: { state: NativeState | null; onDone(): void; onCancel(): void }) {
  const [step, setStep] = useState(state?.dataFolder ? 2 : 0);
  const [st, setSt] = useState(state);
  const [found, setFound] = useState<{ classes: string[]; home: string; platform: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const refresh = () => Kea.state().then(setSt).catch(() => {});

  // What the chosen kea-data.json holds: the classes, and the class site (so it doesn't have to be typed).
  const readFound = async () => {
    const r = await Kea.readFile({ path: 'kea-data.json' });
    const d = JSON.parse(r.text);
    setFound({ classes: (d.courses || []).map((c: any) => c.code), home: d.home || '', platform: d.platform || (/\/d2l\//i.test(d.home || '') ? 'd2l' : 'canvas') });
  };
  useEffect(() => {
    if (state?.dataFolder) readFound().catch(() => {});
  }, []);

  // Which drive Kea's folder is on: asked first, so the steps (and the check after) are that drive's.
  const [drive, setDriveId] = useState<DriveId | null>(() => {
    const saved = localStorage.getItem(DRIVE) as DriveId | null;
    const held = state?.drive as DriveId | undefined;
    return DRIVES.some((d) => d.id === held) ? held! : DRIVES.some((d) => d.id === saved) ? saved : null;
  });
  const setDrive = (d: DriveId | null) => {
    setDriveId(d);
    setWrong('');
    if (d) localStorage.setItem(DRIVE, d);
  };
  const chooseDrive = (d: DriveId) => setDrive(d);
  const drv = DRIVES.find((d) => d.id === drive);
  const [apps, setApps] = useState<Partial<Record<string, boolean>>>({});
  useEffect(() => {
    Kea.drives()
      .then(setApps)
      .catch(() => {});
  }, []);
  // The files came from somewhere other than the drive chosen: most often a copy in Downloads, which never updates.
  const [wrong, setWrong] = useState('');
  const checkFrom = (from?: DriveFrom) => {
    if (!from || !drv || from === drv.id || (drv.id === 'phone' && from !== 'downloads')) return setWrong('');
    setWrong(
      from === 'downloads'
        ? `These came from Downloads, not ${drv.label}. A downloaded copy never updates, so your classes would stay as they are today. Choose them again from ${drv.label}.`
        : `These came from ${placeName(from)}, not ${drv.label}. If that’s where your computer syncs Kea, change the drive above; otherwise choose them again from ${drv.label}.`
    );
  };

  const pickFiles = async () => {
    setBusy('files');
    setMsg('');
    try {
      const r = await Kea.pickFiles({ drive: drive || undefined });
      checkFrom(r.from);
      await readFound();
      await refresh();
    } catch (e: any) {
      if (!/No file/.test(String(e?.message))) setMsg(String(e?.message || e));
    }
    setBusy('');
  };
  const pickFolder = async () => {
    setBusy('folder');
    setMsg('');
    try {
      const r = await Kea.pickFolder();
      checkFrom(r.from);
      await readFound();
      await refresh();
    } catch (e: any) {
      if (!/No folder/.test(String(e?.message))) setMsg(String(e?.message || e));
    }
    setBusy('');
  };
  const signIn = async () => {
    setBusy('signin');
    setMsg('');
    try {
      await Kea.setup({ home: found?.home || st?.home || '', user: user.trim() || undefined, pass: pass || undefined });
      const r = await Kea.signIn({ show: true });
      await refresh();
      if (r.signedIn) setStep(3);
      else setMsg('Not signed in yet. Try again when you’re ready.');
    } catch (e: any) {
      setMsg(String(e?.message || e));
    }
    setBusy('');
  };

  const files = st?.files || [];
  const have = (f: string) => files.includes(f);
  const steps = ['Your computer', 'Kea’s files', 'Class site', 'Notifications'];
  return (
    <div className="pair">
      <div className="pair-top">
        <button className="icon" aria-label="Back" onClick={() => (step === 1 && drive ? setDrive(null) : step ? setStep(step - 1) : onCancel())}>
          <ChevronLeft size={20} />
        </button>
        <span className="pair-steps">
          Step {step + 1} of {steps.length} · {steps[step]}
        </span>
      </div>
      <div className="progress">
        <span style={{ width: `${((step + 1) / steps.length) * 100}%` }} />
      </div>
      <div className="pair-body">
        {step === 0 && (
          <>
            <Laptop size={34} className="pair-ic" />
            <h1>Start on your computer</h1>
            <p>Your classes come from Kea on your Windows computer: it reads your class site and writes your textbooks and practice sets. The phone shows the same things and sends back what you do here.</p>
            <ol className="how">
              <li>Install Kea on your computer and connect your classes there.</li>
              <li>
                In Kea on the computer, open <b>Scans → Devices</b> and turn on sync with <b>Google Drive</b> or <b>OneDrive</b>.
              </li>
              <li>Kea puts a <b>Kea</b> folder in that drive. That folder is how your phone and computer stay in step.</li>
            </ol>
            <button className="btn" onClick={() => Kea.open({ url: DOWNLOAD })}>
              <ExternalLink size={16} /> Get Kea for Windows
            </button>
          </>
        )}
        {step === 1 && !drive && (
          <>
            <Cloud size={34} className="pair-ic" />
            <h1>Where is Kea’s folder?</h1>
            <p>
              The drive your computer syncs Kea through, the one chosen in Kea on the computer under <b>Scans → Devices</b>.
            </p>
            <div className="drives">
              {DRIVES.map((d) => (
                <button key={d.id} className="drive-opt" onClick={() => chooseDrive(d.id)}>
                  {d.id === 'phone' ? <Smartphone size={22} /> : <Cloud size={22} />}
                  <span>
                    <b>{d.label}</b>
                    <span className="muted small block">{d.id === 'phone' ? 'Synced or copied onto this phone' : apps[d.id] === false ? `Needs the ${d.label} app` : apps[d.id] ? 'App is on this phone' : ''}</span>
                  </span>
                  <ChevronRight size={18} className="muted" />
                </button>
              ))}
            </div>
          </>
        )}
        {step === 1 && drv && (
          <>
            <button className="drive-on" onClick={() => setDrive(null)}>
              {drv.id === 'phone' ? <Smartphone size={18} /> : <Cloud size={18} />}
              <span>
                On <b>{drv.id === 'phone' ? 'this phone' : drv.label}</b>
              </span>
              <span className="drive-change">Change</span>
            </button>
            <h1>{drv.id === 'phone' ? 'Choose Kea’s folder' : `Choose Kea’s files from ${drv.label}`}</h1>
            {drv.id !== 'phone' && apps[drv.id] === false && (
              <div className="note warn">
                <p>The {drv.label} app isn’t on this phone. Android only shows a drive’s files through its app: install it and sign in with the same account as your computer.</p>
                <button className="btn" onClick={() => Kea.open({ url: `https://play.google.com/store/apps/details?id=${drv.app}` })}>
                  <ExternalLink size={16} /> Get {drv.label}
                </button>
              </div>
            )}
            {drv.id === 'phone' ? (
              <p>If a sync app keeps your Kea folder on this phone, choose it: the Kea folder or Kea → School both work.</p>
            ) : (
              <ol className="how">
                <li>
                  Tap the button below. If the picker opens somewhere else, tap <b>☰</b> and choose <b>{drv.menu}</b>.
                </li>
                <li>
                  Open <b>{drv.where}</b>.
                </li>
                <li>Press and hold the first file, tap the other two, then tap Select.</li>
              </ol>
            )}
            <div className="filelist">
              {[
                ['kea-data.json', 'your classes, calendar and study sets'],
                ['kea-library.zip', 'your textbooks'],
                ['phone.json', 'what you do here, sent back to your computer']
              ].map(([f, why]) => (
                <div key={f} className={`fl ${have(f) ? 'ok' : ''}`}>
                  {have(f) ? <CheckCircle2 size={18} /> : <Circle size={18} />}
                  <span>
                    <b>{f}</b>
                    <span className="muted small"> {why}</span>
                  </span>
                </div>
              ))}
            </div>
            {drv.id === 'phone' ? (
              <>
                <button className="btn primary" disabled={!!busy} onClick={pickFolder}>
                  {busy === 'folder' ? <Loader2 size={16} className="spin" /> : <FolderOpen size={16} />} {st?.dataFolder && !files.length ? 'Choose the folder again' : 'Choose the folder'}
                </button>
                <button className="btn" disabled={!!busy} onClick={pickFiles}>
                  {busy === 'files' ? <Loader2 size={16} className="spin" /> : <FileText size={16} />} Choose the three files instead
                </button>
              </>
            ) : (
              <>
                <button className="btn primary" disabled={!!busy} onClick={pickFiles}>
                  {busy === 'files' ? <Loader2 size={16} className="spin" /> : <FolderOpen size={16} />} {files.length ? 'Choose the files again' : `Open ${drv.label}`}
                </button>
                <details className="why">
                  <summary>Why not just pick the folder?</summary>
                  <p>
                    {drv.label}’s Android app doesn’t let any app use a whole folder, only files in it, so the folder picker lets you browse but not choose. Picking the three files once works the same: Kea always reads their newest copies.
                  </p>
                </details>
              </>
            )}
            {wrong && <p className="note warn">{wrong}</p>}
            {found && !wrong && (
              <p className="note ok">
                <Check size={15} /> Found your classes: {found.classes.join(', ') || 'none yet'}.
              </p>
            )}
          </>
        )}
        {step === 2 && (
          <>
            <School size={34} className="pair-ic" />
            <h1>Sign in to your class site</h1>
            <p>For notifications about announcements and grades the moment they’re posted, and to hand in scans. Your classes and textbooks already work without it.</p>
            {(found?.home || st?.home) && (
              <p className="note">
                {found?.platform === 'canvas' ? 'Canvas' : 'D2L Brightspace'}: {(found?.home || st?.home || '').replace(/^https?:\/\//, '').split('/')[0]}
              </p>
            )}
            <input className="input" value={user} onChange={(e) => setUser(e.target.value)} placeholder={st?.hasLogin ? 'Username (saved)' : 'School username'} autoCapitalize="none" autoComplete="username" />
            <input className="input" value={pass} onChange={(e) => setPass(e.target.value)} placeholder={st?.hasLogin ? 'Password (saved)' : 'Password'} type="password" autoComplete="current-password" />
            <button className="btn primary" disabled={!!busy || (!found?.home && !st?.home)} onClick={signIn}>
              {busy === 'signin' && <Loader2 size={16} className="spin" />} {st?.signedIn ? 'Signed in · sign in again' : 'Sign in'}
            </button>
            <p className="muted small">Kept in Android’s encrypted storage, only used to sign in to your school. If your school asks for a code, Kea shows its page so you can finish.</p>
          </>
        )}
        {step === 3 && (
          <>
            <Bell size={34} className="pair-ic" />
            <h1>Notifications</h1>
            <p>Kea checks your classes every 15 minutes or so and tells you about new announcements, grades and messages, even when it’s closed.</p>
            <button className="btn primary" onClick={() => Kea.allowNotifications().then(refresh)}>
              <Bell size={16} /> {st?.notifications ? 'Notifications are on' : 'Allow notifications'}
            </button>
          </>
        )}
        {msg && <p className="note warn">{msg}</p>}
      </div>
      <div className="pair-foot">
        {step === 0 && (
          <button className="btn primary big" onClick={() => setStep(1)}>
            Kea on my computer is ready <ChevronRight size={18} />
          </button>
        )}
        {step === 1 && drive && (
          <button className="btn primary big" disabled={!have('kea-data.json') && !found} onClick={() => setStep(2)}>
            Next <ChevronRight size={18} />
          </button>
        )}
        {step === 2 && (
          <button className="btn big" onClick={() => setStep(3)}>
            {st?.signedIn ? 'Next' : 'Skip for now'} <ChevronRight size={18} />
          </button>
        )}
        {step === 3 && (
          <button className="btn primary big" onClick={onDone}>
            <Check size={18} /> Done
          </button>
        )}
      </div>
    </div>
  );
}

/** Settings: classes, class site, notifications, updates and the tour, each explained in a line. */
export function SettingsPage({ state, paired, onPair, onUnpaired, onWelcome, onClose }: { state: NativeState | null; paired: boolean; onPair(): void; onUnpaired(): void; onWelcome(): void; onClose(): void }) {
  const u = useUpdate();
  const [auto, setAuto] = useState(localStorage.getItem(AUTO) !== 'off');
  const [confirm, setConfirm] = useState(false);
  return (
    <div className="m-overlay settings">
      <div className="pair-top">
        <button className="icon" aria-label="Back" onClick={onClose}>
          <ChevronLeft size={20} />
        </button>
        <span className="pair-steps">Settings</span>
      </div>
      <div className="pair-body">
        <section className="set">
          <h2>Classes</h2>
          {paired ? (
            <>
              <div className="set-row">
                <CheckCircle2 size={18} className="ok-ic" />
                <span>
                  <b>Connected to Kea on your computer</b>
                  <span className="muted small block">
                    {[state?.drive && `On ${placeName(state.drive)}`, (state?.files || []).length ? `${state!.files!.length} of 3 files chosen` : 'Through a folder on the phone'].filter(Boolean).join(' · ')}
                  </span>
                </span>
              </div>
              {state?.drive === 'downloads' && <p className="note warn">These files are a copy in Downloads, which never updates. Choose them again from your drive.</p>}
              <button className="btn" onClick={onPair}>
                <FolderOpen size={16} /> Change files or class site
              </button>
              {confirm ? (
                <div className="actions">
                  <button className="btn danger" onClick={() => Kea.unpair().then(onUnpaired)}>
                    Disconnect
                  </button>
                  <button className="btn" onClick={() => setConfirm(false)}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button className="btn ghost danger-text" onClick={() => setConfirm(true)}>
                  Disconnect this phone
                </button>
              )}
            </>
          ) : (
            <>
              <p className="muted small">Your calendar, textbooks, practice exams and inbox, from Kea on your computer.</p>
              <button className="btn primary" onClick={onPair}>
                <GraduationCap size={16} /> Connect my classes
              </button>
            </>
          )}
        </section>
        {paired && (
          <section className="set">
            <h2>Class site</h2>
            <div className="set-row">
              <School size={18} />
              <span>
                <b>{state?.home ? state.home.replace(/^https?:\/\//, '').split('/')[0] : 'Not signed in'}</b>
                <span className="muted small block">{state?.signedIn ? 'Signed in' : state?.hasLogin ? 'Login saved, signs in when needed' : 'For notifications and handing in'}</span>
              </span>
            </div>
          </section>
        )}
        <Appearance />
        <section className="set">
          <h2>Notifications</h2>
          <button className="btn" onClick={() => Kea.allowNotifications()}>
            <Bell size={16} /> {state?.notifications ? 'On' : 'Allow notifications'}
          </button>
        </section>
        <section className="set">
          <h2>Updates</h2>
          <div className="set-row">
            <RefreshCw size={18} />
            <span>
              <b>Kea {u.version || ''}</b>
              <span className="muted small block">
                {u.status === 'checking'
                  ? 'Checking…'
                  : u.status === 'downloading'
                    ? `Downloading ${u.next}… ${u.percent}%`
                    : u.status === 'ready'
                      ? `Kea ${u.next} is ready to install`
                      : u.status === 'current'
                        ? `Up to date: ${u.version} is the newest release${u.checked ? ` (checked ${new Date(u.checked).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })})` : ''}`
                        : u.error
                          ? `Couldn’t check: ${u.error}`
                          : ''}
              </span>
            </span>
          </div>
          <div className="actions">
            {u.status === 'ready' ? (
              <button className="btn primary" onClick={installUpdate}>
                Install {u.next}
              </button>
            ) : (
              <button className="btn" disabled={u.status === 'checking' || u.status === 'downloading'} onClick={() => checkForUpdate(true).catch(toast)}>
                Check for updates
              </button>
            )}
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => {
                setAuto(e.target.checked);
                localStorage.setItem(AUTO, e.target.checked ? 'on' : 'off');
              }}
            />
            <span>Download updates automatically</span>
          </label>
          <p className="muted small">Kea downloads new versions in the background; Android asks you to confirm before it installs.</p>
        </section>
        <section className="set">
          <h2>About</h2>
          <p className="muted small">Kea is free and open source. Your scans and files stay on your phone; your classes sync only through your own drive.</p>
          <button className="btn" onClick={onWelcome}>
            Show the welcome tour
          </button>
        </section>
      </div>
    </div>
  );
}

/** How Kea looks, and how it reads aloud: every colour and size the student's choice. */
function Appearance() {
  const look = useLook();
  const [voices, setVoices] = useState(false);
  return (
    <>
      <section className="set">
        <h2>Appearance</h2>
        <span className="muted small">Theme</span>
        <div className="themes">
          {THEME_LIST.map((t) => (
            <button key={t.id} className={`theme-opt ${look.theme === t.id ? 'on' : ''}`} onClick={() => setLook({ theme: t.id })}>
              <i style={{ background: t.bg, color: t.text, borderColor: t.surface }}>Aa</i>
              {t.label}
            </button>
          ))}
        </div>
        <span className="muted small">Accent colour</span>
        <div className="accents">
          {ACCENT_LIST.map((a) => (
            <button key={a.id} className={`accent-opt ${look.accent === a.id ? 'on' : ''}`} aria-label={a.label} title={a.label} onClick={() => setLook({ accent: a.id })}>
              <i style={{ background: a.id === 'silver' ? 'linear-gradient(135deg, #e3e4e6 50%, #a8c7fa 50%)' : a.color }} />
            </button>
          ))}
        </div>
        <span className="muted small">Size</span>
        <div className="bk-opts">
          {[
            [0.9, 'Smaller'],
            [1, 'Normal'],
            [1.1, 'Larger'],
            [1.2, 'Largest']
          ].map(([v, label]) => (
            <button key={v} className={`bk-chip ${look.scale === v ? 'on' : ''}`} onClick={() => setLook({ scale: v as number })}>
              {label}
            </button>
          ))}
        </div>
        <span className="muted small">Book pages</span>
        <div className="bk-opts">
          {(Object.keys(PAGES) as PageId[]).map((id) => (
            <button key={id} className={`bk-chip ${look.page === id ? 'on' : ''}`} onClick={() => setLook({ page: id })}>
              {PAGES[id].label}
            </button>
          ))}
        </div>
      </section>
      <section className="set">
        <h2>Reading aloud</h2>
        <p className="muted small">Books and flashcards read in the phone’s own voices. Offline voices keep reading with no signal, and reading carries on with the screen off.</p>
        <span className="muted small">Speed for books and documents: {look.rate}×</span>
        <div className="bk-opts">
          {[0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2].map((r) => (
            <button key={r} className={`bk-chip ${look.rate === r ? 'on' : ''}`} onClick={() => setLook({ rate: r })}>
              {r}×
            </button>
          ))}
        </div>
        <input className="range" type="range" min={0.5} max={2.5} step={0.05} value={look.rate} onChange={(e) => setLook({ rate: Number(e.target.value) })} aria-label="Speed" />
        <button className="btn" onClick={() => setVoices(true)}>
          Choose a voice
        </button>
        <span className="muted small">Mark the sentence being read</span>
        <div className="bk-opts">
          {(
            [
              ['fill', 'Highlight'],
              ['underline', 'Underline'],
              ['off', 'Off']
            ] as const
          ).map(([v, l]) => (
            <button key={v} className={`bk-chip ${look.highlight === v ? 'on' : ''}`} onClick={() => setLook({ highlight: v })}>
              {l}
            </button>
          ))}
        </div>
        <label className="toggle">
          <input type="checkbox" checked={look.follow} onChange={(e) => setLook({ follow: e.target.checked })} />
          <span>Turn the pages while reading aloud</span>
        </label>
        <p className="muted small">Listening to flashcards (the Listen mode in any deck) has its own options there: speed, the pause before each answer and between cards, and more.</p>
      </section>
      {voices && <VoiceSheet onClose={() => setVoices(false)} />}
    </>
  );
}
