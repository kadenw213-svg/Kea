// The phone's side of syncing through Kea cloud (the Kea account server; "Hub" in the code): the same files Kea on the
// PC mirrors into the person's Kea storage (electron/scholar/hubsync.cjs), seen from the phone. <profile> is the one
// folder Kea on the PC writes the phone copy into (every class site in it; see newestProfileIn), never shown.
//
//   kea/Kea/<profile>/kea-data.json      written by the PC: classes, calendar, grades, study sets (read here)
//   kea/Kea/<profile>/Textbooks/<CODE>/…  written by the PC: textbook PDFs, one file each (downloaded into the library)
//   kea/Kea/<profile>/phone.json          written by the phone: checkmarks, read, study progress, requests
//
// The same rules as the PC's sync:
// - Only changed files move. Each file's Hub version is remembered, "what changed since <time>" brings in others'
//   changes, and a full listing every 5 minutes catches deletions.
// - Every file has one writer. phone.json is the phone's: a clash (412) means another copy of the phone wrote it, and
//   this change wins, sent over the newer version.
// - Names on the Hub encode characters it doesn't allow as ~<hex>~ (the same encoding as the PC).
// - Mass-delete guard: when most of the library seems to have vanished from the Hub at once, nothing is deleted here.
//   That's a renamed profile or a listing gone wrong, not someone deleting their textbooks.
//
// Pure logic: the Hub client and the storage for the sync state are passed in, so tests run it against a stand-in Hub.

const ALLOWED = /[\p{L}\p{N} ._()+@,'&!-]/u;
export const encodeSeg = (s: string) => [...s].map((c) => (ALLOWED.test(c) ? c : `~${c.codePointAt(0)!.toString(16)}~`)).join('');
/**
 * A name as the PC wrote it, or null when it can't be one: a ~hex~ that isn't a code point (more than 6 hex digits, or
 * past U+10FFFF). Such a file is skipped and the sync goes on (the same as Kea on the PC), instead of stopping on it.
 */
export const decodeSeg = (s: string): string | null => {
  let bad = false;
  const out = s.replace(/~([0-9a-f]+)~/g, (_, h: string) => {
    const n = h.length <= 6 ? parseInt(h, 16) : Infinity;
    if (!(n <= 0x10ffff)) {
      bad = true;
      return '';
    }
    return String.fromCodePoint(n);
  });
  return bad ? null : out;
};
/** "Kea/School/kea-data.json" → "kea/Kea/School/kea-data.json" (encoded the way the PC's sync does). */
export const toRemote = (rel: string) => `kea/${rel.split(/[\\/]/).map(encodeSeg).join('/')}`;
/** A Hub path as a path in the Kea folder, or null when one of its names can't be decoded (see decodeSeg). */
export const toLocal = (remote: string): string | null => {
  const segs = remote.slice(4).split('/').map(decodeSeg);
  return segs.includes(null) ? null : segs.join('/');
};

export const FULL_EVERY = 5 * 60_000;
/** Files the phone keeps from the PC's folder: the textbooks (and question pictures, if the PC sends them). */
export const LIBRARY = /^(Textbooks|study\/images)\//;

export interface HubFile {
  path: string;
  size: number;
  version: number;
  sha256: string;
  updatedAt: number;
}
export interface HubError extends Error {
  status?: number;
  data?: any;
}
export interface SyncClient {
  list(prefix: string, since: number): Promise<{ files: HubFile[]; now?: number }>;
  getText(path: string): Promise<{ text: string; version: number }>;
  /** Download into the library folder at `to` (skipped when the copy there already matches `sha256`). */
  download(path: string, to: string, f: HubFile): Promise<void>;
  removeLocal(to: string): Promise<void>;
  putText(path: string, text: string, opts: { ifMatch?: number; ifNoneMatch?: boolean }): Promise<{ version: number }>;
}
export interface SyncState {
  profile: string;
  since: number;
  fullAt: number;
  /** kea-data.json's version when it was last read. */
  dataV: number;
  /** Library files on the phone: their Hub version. */
  lib: Record<string, number>;
  /** Library files listed as changed (or new) and not downloaded yet: kept so a closed app picks up where it was. */
  todo: Record<string, HubFile>;
  /** Library files gone from the Hub, to remove here. */
  gone: string[];
  /** phone.json: its Hub version, and a hash of the text last sent. */
  phoneV: number;
  phoneSent: string;
}
export const emptyState = (profile = ''): SyncState => ({ profile, since: 0, fullAt: 0, dataV: 0, lib: {}, todo: {}, gone: [], phoneV: 0, phoneSent: '' });

/** The profiles (Kea → <name>) in someone's Kea storage that have Kea's data file, from a listing of kea/Kea/. */
export function profilesIn(files: Pick<HubFile, 'path'>[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    const m = /^kea\/Kea\/([^/]+)\/kea-data\.json$/.exec(f.path);
    const name = m ? decodeSeg(m[1]) : null;
    if (name != null) out.add(name);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/**
 * The folder the phone reads: the one whose kea-data.json is newest. Kea on the computer writes one phone copy holding
 * every class site into one folder (Kea → <name>); folders from before one calendar per account may linger, stale.
 * Null when there's none yet. A tie goes to the first name in order, so the choice doesn't flip.
 */
export function newestProfileIn(files: Pick<HubFile, 'path' | 'updatedAt'>[]): string | null {
  let best: { name: string; at: number } | null = null;
  for (const f of files) {
    const m = /^kea\/Kea\/([^/]+)\/kea-data\.json$/.exec(f.path);
    const name = m ? decodeSeg(m[1]) : null;
    if (name == null) continue;
    const at = Number(f.updatedAt) || 0;
    if (!best || at > best.at || (at === best.at && name.localeCompare(best.name) < 0)) best = { name, at };
  }
  return best?.name ?? null;
}

/** A short, stable fingerprint of phone.json's text (what changed is all that matters, not secrecy). */
export function fingerprint(s: string) {
  let h1 = 0x811c9dc5,
    h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return `${s.length}:${(h1 >>> 0).toString(16)}:${(h2 >>> 0).toString(16)}`;
}

export function createPhoneSync({
  client,
  load,
  save,
  now = Date.now,
  log = () => {}
}: {
  client: SyncClient;
  load(): SyncState | null;
  save(s: SyncState): void;
  now?: () => number;
  log?: (m: string) => void;
}) {
  let st: SyncState = load() || emptyState();
  const keep = () => save(st);
  const base = () => toRemote(`Kea/${st.profile}`) + '/';
  /** The path inside the profile's folder, or null for a name that can't be decoded (skipped). */
  const relOf = (remote: string) => {
    const local = toLocal(remote);
    return local == null ? null : local.slice(`Kea/${st.profile}/`.length);
  };

  /** Switch to another profile (or the first one): everything is read again from scratch. */
  function use(profile: string) {
    if (st.profile === profile) return;
    // (Textbooks already on the phone stay: ones that match the Hub's aren't downloaded again, see client.download.)
    st = emptyState(profile);
    keep();
  }

  /**
   * Look at what changed on the Hub. Returns kea-data.json's text when it changed (or `wantData` asks for it anyway,
   * for a phone with no copy of its own), else null. Library changes are queued for `library()`.
   */
  async function pull(wantData = false): Promise<{ data: string | null; dataVersion: number }> {
    if (!st.profile) throw Object.assign(new Error('No classes in Kea cloud yet. Sign in to the same Kea account in Kea on your computer and keep it syncing through Kea cloud; your classes come here.'), { status: 0 });
    const full = now() - st.fullAt > FULL_EVERY;
    const list = await client.list(base(), full ? 0 : st.since);
    const seen = new Set<string>();
    let dataFile: HubFile | null = null;
    for (const f of list.files) {
      if (!f.path.startsWith(base())) continue;
      const rel = relOf(f.path);
      if (rel == null) {
        log(`Skipped a file with a name that can't be read: ${f.path.slice(0, 120)}`);
        continue;
      }
      if (rel === 'kea-data.json') dataFile = f;
      else if (rel === 'phone.json') {
        // (Written by this phone; another copy of it may have written it since: the next send goes over that version.)
        if (f.version > st.phoneV) st.phoneV = f.version;
      } else if (LIBRARY.test(rel)) {
        seen.add(rel);
        if (st.lib[rel] !== f.version) st.todo[rel] = f;
        else delete st.todo[rel];
      }
    }
    if (full) {
      const tracked = Object.keys(st.lib);
      const missing = tracked.filter((rel) => !seen.has(rel));
      for (const rel of Object.keys(st.todo)) if (!seen.has(rel)) delete st.todo[rel];
      if (missing.length > 20 && missing.length > tracked.length / 2) {
        log(`Kea cloud sync: ${missing.length} of ${tracked.length} textbook files are missing from Kea cloud at once, so none were removed from this phone.`);
      } else st.gone = [...new Set([...st.gone, ...missing])];
      st.fullAt = now();
    }
    // (A little overlap, so a change made at the same moment as the listing isn't missed.)
    st.since = Math.max(0, (list.now ?? now()) - 5000);
    let data: string | null = null;
    if (dataFile ? dataFile.version !== st.dataV || wantData : wantData) {
      // (Not in a "what changed" listing means unchanged; asked for anyway, it's read by name.)
      try {
        const r = await client.getText(dataFile?.path ?? base() + 'kea-data.json');
        data = r.text;
        st.dataV = r.version || dataFile?.version || 0;
      } catch (e: any) {
        keep();
        if (e?.status === 404) throw Object.assign(new Error('No classes in Kea cloud yet. Sign in to the same Kea account in Kea on your computer and keep it syncing through Kea cloud; your classes come here.'), { status: 404 });
        throw e;
      }
    }
    keep();
    return { data, dataVersion: st.dataV };
  }

  /** Bring the library up to date: download what changed, remove what the PC deleted. One file at a time. */
  async function library(progress: (p: { files: number; name: string }) => void = () => {}) {
    let files = 0;
    let errors = 0;
    for (const [rel, f] of Object.entries(st.todo)) {
      try {
        await client.download(f.path, rel, f);
        st.lib[rel] = f.version;
        delete st.todo[rel];
        files++;
        progress({ files, name: rel });
      } catch (e: any) {
        if (e?.status === 404) delete st.todo[rel];
        else if (e?.status === 401 || e?.status === 428) throw e;
        else errors++;
      }
      keep();
    }
    let removed = 0;
    for (const rel of st.gone) {
      try {
        await client.removeLocal(rel);
      } catch {}
      delete st.lib[rel];
      removed++;
    }
    st.gone = [];
    keep();
    return { files, removed, errors, total: Object.keys(st.lib).length };
  }

  /** Send phone.json when its text changed. This phone's copy wins a clash. */
  async function push(text: string) {
    if (!st.profile) return false;
    const fp = fingerprint(text);
    if (fp === st.phoneSent) return false;
    const path = base() + 'phone.json';
    const send = (opts: { ifMatch?: number; ifNoneMatch?: boolean }) => client.putText(path, text, opts);
    let r: { version: number };
    try {
      r = await send(st.phoneV ? { ifMatch: st.phoneV } : { ifNoneMatch: true });
    } catch (e: any) {
      if (e?.status !== 412) throw e;
      const v = e.data?.version;
      r = await send(v ? { ifMatch: v } : { ifNoneMatch: true });
    }
    st.phoneV = r.version;
    st.phoneSent = fp;
    keep();
    return true;
  }

  return { use, pull, library, push, state: () => st, reset: () => ((st = emptyState()), keep()) };
}
