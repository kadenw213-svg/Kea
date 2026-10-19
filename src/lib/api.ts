export interface FileEntry {
  path: string;
  name: string;
  data: Uint8Array;
  size?: number;
}
export interface RecentEntry {
  path: string;
  name: string;
  openedAt: number;
}
export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface DirEntry {
  path: string;
  name: string;
  dir: boolean;
  size: number;
  mtime: number;
  /** Cloud file that isn't downloaded to this PC yet. */
  online?: boolean;
}
export interface KnownFolder {
  id: string;
  label: string;
  path: string;
}
export type DriveId = 'onedrive' | 'gdrive' | 'dropbox' | 'icloud';
export interface DriveInfo {
  id: DriveId;
  label: string;
  installed: boolean;
  accounts: { label: string; path: string }[];
}
export interface DriveProgress {
  id: DriveId;
  status: 'downloading' | 'verifying' | 'installing' | 'error';
  received?: number;
  total?: number;
  error?: string;
}
export type FilePreview =
  | { type: 'image'; src: string; w: number; h: number }
  | { type: 'doc'; html: string }
  | { type: 'text'; text: string }
  | { type: 'grid'; rows: string[][] }
  | { type: 'slide'; slide: any; w: number; h: number; font: string }
  | { type: 'none' };
export interface FileMeta {
  description?: string;
}
export interface HomeSettings {
  view?: 'grid' | 'list';
  sort?: 'recent' | 'modified' | 'name';
  tone?: 'dark' | 'light';
  folders?: string[];
  source?: string;
}

export interface VersionInfo {
  id: string;
  ts: number;
  size: number;
  label?: string;
}
export interface RecoveryEntry {
  tabId: string;
  name: string;
  path: string | null;
  kind: string;
  ext: string;
  savedAt: number;
}

export interface KeaApi {
  setZoom(factor: number): void;
  settings: {
    get(): Promise<Record<string, any>>;
    set(patch: Record<string, any>): Promise<Record<string, any>>;
    onChange(cb: (all: Record<string, any>) => void): () => void;
  };
  history: {
    list(path: string): Promise<VersionInfo[]>;
    read(path: string, id: string): Promise<Uint8Array>;
    snapshot(path: string, label?: string): Promise<VersionInfo | null>;
    label(path: string, id: string, label: string): Promise<VersionInfo[]>;
    remove(path: string, id: string): Promise<VersionInfo[]>;
    usage(): Promise<number>;
    clear(): Promise<boolean>;
    openFolder(): Promise<string>;
  };
  present: {
    screens(): Promise<number>;
    open(html: string, start: number): Promise<boolean>;
    goto(i: number, type: string, duration: number, dir: number): Promise<boolean>;
    close(): Promise<boolean>;
    onClosed(cb: () => void): () => void;
  };
  scholar: {
    profiles(): Promise<ProfileList>;
    createProfile(name: string): Promise<ProfileList>;
    selectProfile(id: string): Promise<ProfileList>;
    renameProfile(id: string, name: string): Promise<ProfileList>;
    status(): Promise<{ hasData: boolean; paths: { dir: string; workspace: string; db: string; textbooks: string } }>;
    courses(): Promise<ScholarCourse[]>;
    items(q: { from: string; to: string; courseId?: string }): Promise<ScholarItem[]>;
    course(id: string): Promise<ScholarCourseDetail | null>;
    setDone(id: string, done: boolean): Promise<boolean>;
    importExisting(folder: string): Promise<{ pdfs: number }>;
    school(): Promise<SchoolInfo>;
    setSchoolHome(home: string): Promise<SchoolInfo>;
    signIn(remember: boolean): Promise<SchoolInfo & { signedIn: boolean }>;
    forgetLogin(): Promise<SchoolInfo>;
    siteStatus(): Promise<{ setUp: boolean; signedIn: boolean; home?: string }>;
    check(): Promise<ScholarSetup>;
    installUv(): Promise<{ code: number; out: string }>;
    installClaude(): Promise<{ code: number; out: string }>;
    signInClaude(): Promise<ClaudeAccount>;
    setupEngine(): Promise<boolean>;
    /** On a device that isn't the primary, the primary is asked instead: `relayed` names it. */
    run(task: 'daily' | 'import' | 'sync' | 'study' | 'probe', arg?: string): Promise<boolean | { relayed: string; online: boolean }>;
    /** Your devices: the drive they sync through, which one is the primary, and what it's running. */
    devices(): Promise<DevicesStatus>;
    /** Classes other devices share, found in every drive on this one, and what's missing when there are none. */
    devicesFind(): Promise<{ found: DeviceShare[]; notes: string[]; me: string }>;
    /** Use one of those here (this device follows the primary). */
    devicesJoin(choice: DeviceShare): Promise<{ ok: boolean; primary?: boolean; from?: string; waiting?: string }>;
    /** Make a device (by id) the one that scans. */
    makePrimary(id: string): Promise<DevicesStatus>;
    /** Sync through this drive: 'auto', 'onedrive', 'google', another drive's id, 'custom' or 'off'. */
    setDrive(choice: string): Promise<DevicesStatus>;
    /** Practice exams and flashcard decks, newest first. */
    studyList(): Promise<StudySet[]>;
    /** One set with its questions or cards. */
    studyGet(id: string): Promise<StudySetFull | null>;
    /** Ask Claude for a new set (for a test or assignment, or for chapters). Resolves with its id once queued. */
    /** mode: 'mix' reuses up to 60% saved questions and has Claude write the rest; 'saved' uses saved ones only (ready at once); 'new' writes them all. */
    studyMake(req: { id?: string; kind: StudyKind; courseId: string; chapters?: string[]; itemId?: string | null; count?: number; mode?: 'mix' | 'saved' | 'new' }): Promise<string>;
    /** How many saved questions (or cards) a set on these chapters, or for this test, could reuse. */
    studySaved(req: { kind: StudyKind; courseId: string; chapters?: string[]; itemId?: string | null }): Promise<{ count: number }>;
    /** Which class and chapters a textbook PDF is (for Quiz me), or null. */
    textbookOf(file: string): Promise<{ courseId: string; code: string; chapters: string[] } | null>;
    /** Write question banks for chapters that have none (on the primary); false when Claude isn't connected. */
    studyBanks(): Promise<boolean>;
    studyDelete(id: string): Promise<boolean>;
    /** items: how each question went, [key, right] (right null for an unmarked written answer). */
    studyAttempt(id: string, a: { score: number; total: number; n: number; items?: [string, boolean | null][] }): Promise<boolean>;
    studyKnown(id: string, known: number[]): Promise<boolean>;
    stop(): Promise<boolean>;
    runStatus(): Promise<{ running: ScholarRun | null; queued: QueuedRun[] }>;
    activity(): Promise<ScholarRun[]>;
    news(): Promise<ScholarNews[]>;
    markNewsRead(ids?: string[]): Promise<boolean>;
    /** Announcements (straight from the class site) and what scans found, newest first. */
    inbox(): Promise<ScholarInboxItem[]>;
    markInboxRead(ids?: string[]): Promise<boolean>;
    deleteInbox(ids: string[]): Promise<boolean>;
    /** Look for new announcements now (no Claude). False when Kea isn't signed in. */
    checkInbox(): Promise<boolean>;
    /** Cloud drives on this computer, and the folder Kea keeps the phone's copy in. */
    cloudDrives(): Promise<{ drives: { id: string; label: string; path: string }[]; target: string | null }>;
    /** Update the phone's copy now. */
    syncNow(): Promise<{ dir: string; hash: string } | null>;
    /** Every class's assignment folders a file can be handed in to. */
    handInTargets(): Promise<{ code: string; ou: string; folders: { id: number; name: string; due: string | null; closed: boolean; submitted: boolean }[] }[]>;
    /** Open the folder's D2L hand-in page with the file in its upload box. The student presses Submit there. */
    handIn(ou: string, folderId: number, file: string): Promise<{ attached: boolean }>;
    /** A class's overall grade and graded items, or null before anything is known. */
    grades(courseId: string, code: string): Promise<ScholarGrades | null>;
    /** Open a link: class-site pages in Kea's signed-in window, anything else in the web browser. */
    openLink(url: string): Promise<boolean>;
    /** A run paused by a Claude usage limit, waiting to continue. */
    pending(): Promise<ScholarPending | null>;
    /** Continue the paused run now, or the last stopped run of a task. */
    resume(task?: string): Promise<boolean>;
    onResume(cb: (p: ScholarPending | null) => void): () => void;
    onRun(cb: (r: ScholarRun & { running: boolean }) => void): () => void;
    onNews(cb: (n: ScholarNews) => void): () => void;
    onSetupLine(cb: (line: string) => void): () => void;
    onChanged(cb: () => void): () => void;
  };
  lookup: {
    search(query: string, lang?: string): Promise<WikiCandidate[]>;
    find(query: string, lang?: string, limit?: number): Promise<WikiCandidate[]>;
    article(title: string, lang?: string): Promise<WikiPage | null>;
    titles(list: string[], lang?: string): Promise<WikiCandidate[]>;
    complete(prefix: string, lang?: string): Promise<string[]>;
    about(list: string[], lang?: string): Promise<Record<string, { intro: string; categories: string[] }>>;
    meanings(title: string, lang?: string): Promise<WikiCandidate[]>;
    define(word: string, maxSenses?: number): Promise<DictEntry | null>;
    wiktionary(word: string): Promise<DictEntry | null>;
  };
  speech: {
    state(): Promise<SpeechModel[]>;
    download(id: string): Promise<boolean>;
    pause(id: string): Promise<boolean>;
    remove(id: string): Promise<boolean>;
    onDownload(cb: (m: SpeechModel) => void): () => void;
  };
  tts: {
    voices(): Promise<string[]>;
    speak(text: string, voice: string, rate: number): Promise<boolean>;
    stop(): Promise<boolean>;
  };
  searchContent(query: string, roots?: string[]): Promise<{ path: string; name: string; snippet: string; nameHit: boolean }[]>;
  citeLookup(query: string): Promise<any>;
  google: {
    status(): Promise<{ configured: boolean; signedIn: boolean; email: string | null; name: string | null }>;
    signIn(): Promise<{ email?: string; name?: string }>;
    signOut(): Promise<boolean>;
    open(localPath: string): Promise<{ id: string; name: string; ext: string; kind: 'doc' | 'sheet' | 'slides'; google: string; canEdit: boolean; modifiedTime: string; data: Uint8Array }>;
    save(id: string, ext: string, data: Uint8Array): Promise<{ id: string; modifiedTime: string }>;
  };
  recovery: {
    put(meta: Omit<RecoveryEntry, 'savedAt'>, data: Uint8Array): Promise<boolean>;
    drop(tabId: string): Promise<boolean>;
    list(): Promise<RecoveryEntry[]>;
    read(tabId: string): Promise<Uint8Array>;
  };
  platform: string;
  openDialog(opts?: { title?: string; multi?: boolean; filters?: FileFilter[] }): Promise<FileEntry[]>;
  saveDialog(opts?: { title?: string; defaultPath?: string; filters?: FileFilter[] }): Promise<string | null>;
  readFile(p: string): Promise<FileEntry>;
  writeFile(p: string, data: Uint8Array): Promise<boolean>;
  fileExists(p: string): Promise<boolean>;
  /** Rename a file in place; fails if the new name is taken. */
  renameFile(from: string, to: string): Promise<boolean>;
  showInFolder(p: string): Promise<void>;
  getRecent(): Promise<RecentEntry[]>;
  addRecent(p: string): Promise<RecentEntry[]>;
  removeRecent(p: string): Promise<RecentEntry[]>;
  clearRecent(): Promise<RecentEntry[]>;
  listDir(dir: string, opts?: { cloud?: boolean; allOnline?: boolean; allTypes?: boolean; hidden?: boolean }): Promise<DirEntry[]>;
  searchDir(dir: string, query: string, opts?: { allTypes?: boolean; hidden?: boolean }): Promise<DirEntry[]>;
  statMany(paths: string[]): Promise<{ path: string; exists: boolean; size?: number; mtime?: number }[]>;
  knownFolders(): Promise<KnownFolder[]>;
  openFolderDialog(): Promise<string | null>;
  isDir(p: string): Promise<boolean>;
  openPath(p: string): Promise<string>;
  getPreview(p: string): Promise<FilePreview | null>;
  clearPreviews(): Promise<boolean>;
  clearMeta(): Promise<Record<string, FileMeta>>;
  openDataFolder(): Promise<string>;
  sysinfo(): Promise<{ version: string; os: string; cpu: string; ramGb: number; electron: string; logTail: string }>;
  setPreview(p: string, preview: FilePreview): Promise<boolean>;
  getMeta(): Promise<Record<string, FileMeta>>;
  setMeta(p: string, patch: FileMeta): Promise<Record<string, FileMeta>>;
  homeSettings(): Promise<HomeSettings>;
  setHomeSettings(patch: HomeSettings): Promise<HomeSettings>;
  detectDrives(): Promise<DriveInfo[]>;
  connectDrive(id: DriveId): Promise<{ action: 'launched' | 'installing' | 'web' }>;
  onDriveProgress(cb: (m: DriveProgress) => void): () => void;
  printHtml(html: string, opts?: { noMargins?: boolean }): Promise<boolean>;
  pdfFromHtml(html: string, opts?: { pageSize?: string; noMargins?: boolean }): Promise<Uint8Array>;
  getPendingOpen(): Promise<string[]>;
  getPathForFile(file: File): string;
  onOpenPaths(cb: (paths: string[]) => void): () => void;
  onBeforeClose(cb: () => void): () => void;
  confirmClose(): void;
  getVersion(): Promise<string>;
  checkForUpdates(): Promise<{ status: string; message?: string }>;
  downloadUpdate(): Promise<boolean>;
  installUpdate(): void;
  onUpdateState(cb: (s: UpdateState) => void): () => void;
  account: AccountApi;
  ai: AiApi;
}

export type AiTier = 'light' | 'balanced' | 'best';
export interface AiSettings {
  slider: number;
  tier: AiTier;
  contextSize: number;
  maxTokens: number;
  gpu: boolean;
  gpuLayers: 'auto' | number;
  threads: number;
  temperature: number;
  keepLoaded: boolean;
  custom: boolean;
}
export interface AiModelState {
  tier: AiTier;
  label: string;
  model: string;
  license: string;
  size: number;
  minRam: number;
  blurb: string;
  installed: boolean;
  download: { status: 'downloading' | 'paused' | 'verifying' | 'done' | 'error'; received: number; total: number; error?: string } | null;
}
export interface AiHardware {
  gpu: string | false;
  gpuNames: string[];
  vramTotal: number;
  vramFree: number;
  unified: boolean;
  ramTotal: number;
  ramFree: number;
  cpuThreads: number;
  cpuName: string;
}
export interface AiState {
  hardware: AiHardware;
  settings: AiSettings;
  recommended: { slider: number; tier: AiTier; contextSize: number; maxTokens: number };
  presets: { tier: AiTier; contextSize: number; maxTokens: number }[];
  models: AiModelState[];
}
export type AvatarCrop = { x: number; y: number; zoom: number; w: number; h: number };
/** The Kea account (needed for school mode): verified when the email is signed in on this computer. */
export interface KeaAccount {
  email: string;
  name: string;
  avatar: string | null;
  /** Where the picture sits in its circle (null: centred). */
  crop: AvatarCrop | null;
  verified: boolean;
  verifiedBy: string | null;
  /** Kea's creator. */
  owner: boolean;
}
export interface AccountApi {
  get(): Promise<KeaAccount | null>;
  /** Emails signed in on this computer (Claude, OneDrive, Google), to pick from. */
  suggest(): Promise<string[]>;
  save(a: { email: string; name: string }): Promise<KeaAccount | null>;
  verify(): Promise<KeaAccount>;
  avatar(clear?: boolean): Promise<KeaAccount | null>;
  crop(c: AvatarCrop | null): Promise<KeaAccount | null>;
  signOut(): Promise<boolean>;
}

export interface AiGenerateRequest {
  system?: string;
  history?: { role: 'user' | 'assistant'; text: string }[];
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  jsonSchema?: any;
}
export type AiEvent =
  | { type: 'token'; id: string; text: string }
  | { type: 'done'; id: string; text: string; tokensPerSecond?: number; aborted?: boolean }
  | { type: 'error'; id: string; message: string };
export interface AiApi {
  state(): Promise<AiState>;
  setSettings(patch: Partial<AiSettings>): Promise<AiSettings>;
  resetSettings(): Promise<AiSettings>;
  download(tier: AiTier): Promise<boolean>;
  pauseDownload(tier: AiTier): Promise<boolean>;
  deleteModel(tier: AiTier): Promise<boolean>;
  generate(req: AiGenerateRequest): Promise<string>;
  stop(id: string): Promise<boolean>;
  count(text: string): Promise<number>;
  benchmark(): Promise<{ loadMs: number; tokensPerSecond: number }>;
  onEvent(cb: (e: AiEvent) => void): () => void;
  onDownload(cb: (m: AiModelState) => void): () => void;
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'latest' | 'downloading' | 'ready' | 'error' | 'dev';
  version?: string;
  percent?: number;
  message?: string;
  notes?: string;
}

declare global {
  interface Window {
    api: KeaApi;
  }
}

/** A Wikipedia search result: title, short description, first two sentences. */
// ---------- Kea Scholar ----------
export interface SchoolInfo {
  home: string;
  host: string;
  /** Kea saved a login to sign in with (the login itself never leaves Kea's main process). */
  remembers: boolean;
  loginHost: string;
}
export interface ClaudeAccount {
  loggedIn: boolean;
  email?: string;
  method?: string;
  plan?: string;
}
/** A profile's classes shared through a drive by the device that scans them (its primary). */
export interface DeviceShare {
  drive: string;
  label: string;
  account: string;
  root: string;
  profile: string;
  primary: string;
  at: string;
  /** This device is the primary for it. */
  mine: boolean;
  /** Its class database has fully arrived on this device. */
  ready: boolean;
}

export interface CloudDrive {
  id: string;
  label: string;
  path: string;
  /** The signed-in account (OneDrive's email), or a drive letter. */
  account: string;
}

export interface DeviceInfo {
  id: string;
  name: string;
  at: string;
  version: string;
  drive: { label: string; account: string } | null;
  primary: boolean;
  me: boolean;
  online: boolean;
}

/** A waiting run, with what it usually takes. */
export interface QueuedRun {
  task?: string;
  arg: string;
  label: string;
  expectedMs: number;
}

/** What a run reports for its progress bar (also sent from the primary to the other devices). */
export interface RunProgress {
  label: string;
  arg: string;
  start: string;
  phase?: 'check' | 'claude';
  claudeStart?: string | null;
  expectedMs?: number;
  expectedTurns?: number;
  turns?: number;
  percent?: number | null;
  batch?: { done: number; total: number } | null;
  step?: string;
}

export interface DevicesStatus {
  on: boolean;
  me: { id: string; name: string };
  drive: CloudDrive | null;
  drives: CloudDrive[];
  choice: string;
  role: 'primary' | 'follower' | 'alone';
  folder?: string;
  primary: { id: string; name: string; at: string; online: boolean } | null;
  devices: DeviceInfo[];
  phone: { at: string } | null;
  /** On a device that isn't the primary: what the primary is running now, and what's waiting. */
  run: RunProgress | null;
  queue: QueuedRun[];
  pending?: ScholarPending | null;
  elsewhere: DeviceShare[];
  /** The primary's classes are still arriving: how much of the database is here. */
  waiting: { since: string; have: number; of: number } | null;
  pulledAt?: string | null;
}

export interface ScholarSetup {
  uv: string | null;
  claude: string | null;
  account: ClaudeAccount;
  engineReady: boolean;
  hasData: boolean;
}
export interface ScholarRun {
  id: string;
  task: string;
  label: string;
  arg: string;
  why: string;
  start: string;
  end: string | null;
  ok: boolean | null;
  summary: string;
  steps: { at: string; message: string }[];
  /** Set when the run stopped at a Claude usage limit: when Kea continues it. */
  paused?: string;
  phase?: 'check' | 'claude';
  claudeStart?: string | null;
  expectedMs?: number;
  expectedTurns?: number;
  turns?: number;
  percent?: number | null;
  /** Whether Claude was used (false: Kea's own check found nothing to do). */
  claude?: boolean;
  batch?: { id: string; done: number; total: number } | null;
}
export interface ScholarGrades {
  final: { shown: string; percent: number | null } | null;
  items: { id: string; title: string; score: string; percent: number | null; shown: string; comment: string; at: string | null }[];
  url: string;
  checked: string | null;
}
export interface ScholarInboxItem {
  id: string;
  /**
   * One message about one thing. From the class site directly: announcement, grade, feedback, message, update. From a
   * scan: needs_you, attention, missed (and grade/feedback from outside platforms). "news" is an old daily overview.
   */
  kind: 'announcement' | 'grade' | 'feedback' | 'message' | 'update' | 'needs_you' | 'attention' | 'missed' | 'news';
  course: string;
  title: string;
  body: string;
  at: string;
  url: string;
  /** Buttons to show (the text itself has no addresses in it). */
  links?: { label: string; url: string }[];
  /** For grades and feedback: the score as shown, and its percent. */
  score?: string;
  percent?: number | null;
  read: boolean;
  updated?: boolean;
}
export interface ScholarPending {
  task: string;
  arg: string;
  label: string;
  until: string;
}
export interface ScholarNews {
  id: string;
  at: string;
  read: boolean;
  course: string;
  title: string;
  body: string;
}
export interface ProfileList {
  active: string;
  list: { id: string; name: string; created: string }[];
}
export type StudyKind = 'exam' | 'cards';
export interface StudySet {
  id: string;
  kind: StudyKind;
  title: string;
  courseId: string;
  courseCode: string;
  chapters: string[];
  itemId: string | null;
  itemTitle: string | null;
  count: number;
  createdAt: string;
  status: 'making' | 'ready' | 'failed';
  source: 'claude' | 'saved' | 'library';
  /** How many of its items were reused from saved sets. */
  reused?: number;
  error?: string;
  attempts: number;
  /** Best score as a fraction (0–1), or null before any attempt. */
  best: number | null;
  last: { at: string; score: number; total: number; n: number } | null;
  known: number;
}
/** k: the question's key (the same question in two sets has the same key); section: the textbook section that answers it. */
type QuestionBase = { k?: string; explain: string; chapter: string | null; section?: string | null; topic: string | null; source: string | null };
export type StudyQuestion = QuestionBase &
  (
  | { type: 'mc'; q: string; choices: string[]; answer: number; explain: string; chapter: string | null; topic: string | null; source: string | null }
  | { type: 'multi'; q: string; choices: string[]; answer: number[]; explain: string; chapter: string | null; topic: string | null; source: string | null }
  | { type: 'tf'; q: string; answer: boolean; explain: string; chapter: string | null; topic: string | null; source: string | null }
  | { type: 'num'; q: string; answer: number; tolerance: number; unit: string | null; explain: string; chapter: string | null; topic: string | null; source: string | null }
  | { type: 'short'; q: string; answer: string; explain: string; chapter: string | null; topic: string | null; source: string | null }
  /** Fill in the blank ("____" in q): a word or two; `accept` lists other forms that count (a symbol, a synonym). */
  | { type: 'blank'; q: string; answer: string; accept?: string[]; explain: string; chapter: string | null; topic: string | null; source: string | null }
  );
/** How a question has gone, across every set and device. */
export interface StudyHistory {
  seen: number;
  right: number;
  last: string;
  lastRight: boolean | null;
}
export interface StudyCard {
  k?: string;
  front: string;
  back: string;
  chapter: string | null;
  section?: string | null;
  topic?: string | null;
}
export type StudySetFull = Omit<StudySet, 'known' | 'attempts' | 'best' | 'last'> & { questions?: StudyQuestion[]; cards?: StudyCard[]; known: number[]; history?: Record<string, StudyHistory> };
export interface ScholarReading {
  chapter: string;
  title: string | null;
  /** A two-or-three-sentence description of the chapter. */
  summary?: string | null;
  /** The chapter's study PDF in the class textbook, when one has been made. */
  pdf: { file: string; pages: number | null; title: string } | null;
}
export interface ScholarLink {
  label: string;
  url: string;
  kind: string;
  chapter?: string | null;
}
export interface ScholarItem {
  id: string;
  courseId: string;
  courseCode: string;
  type: string;
  title: string;
  date: string;
  dateEnd: string | null;
  start: string | null;
  end: string | null;
  due: string | null;
  module: string | null;
  /** Room or place ("PPSC Rampart Range Campus, E112", "Online"). */
  location: string | null;
  /** The location is the class's usual room for this kind of meeting, not one this item names itself. */
  locationUsual: boolean;
  instructor: string | null;
  contact: string | null;
  description: string | null;
  sourceWording: string | null;
  links: ScholarLink[];
  weeklyLinks: ScholarLink[];
  covered: string[];
  studyFocus: string[];
  points: number | null;
  optional: boolean;
  tentative: boolean;
  /** When it was checked off, or null. */
  done: string | null;
  /** What the class site says: graded or handed in, confirmed not handed in, or null when Kea can't tell. */
  handIn: 'graded' | 'submitted' | 'not_submitted' | null;
  readings: ScholarReading[];
}
export interface ScholarCourse {
  id: string;
  code: string;
  name: string;
  term: string;
  instructor: string | null;
  url: string | null;
  synthetic: boolean;
  start: string | null;
  end: string | null;
  next: { id: string; title: string; type: string; date: string; due: string | null } | null;
  dueThisWeek: number;
  chapters: number;
}
export interface ScholarChapter {
  label: string;
  title: string | null;
  summary: string | null;
  sections: string[];
  objectives: string[];
  vocabulary: string;
  readingUrl: string | null;
  readingLabel: string | null;
  pdf: ScholarReading['pdf'];
}
export interface ScholarCourseDetail {
  id: string;
  code: string;
  name: string;
  term: string;
  instructor: string | null;
  contact: string | null;
  campus: string | null;
  delivery: string | null;
  url: string | null;
  start: string | null;
  end: string | null;
  chapters: ScholarChapter[];
  weeks: ScholarItem[];
  portal: { kind: string; label: string; url: string }[];
}

export interface WikiCandidate {
  title: string;
  description: string;
  intro: string;
  disambiguation: boolean;
  rank: number;
  /** For articles found from a phrase in the reading: that phrase. */
  phrase?: string;
  /** When the term redirects here: the section the redirect points at (may be empty), and the term as redirected. */
  fragment?: string;
  redirectFrom?: string;
  /** When the search matched a section of the article: that section's title. */
  section?: string;
  /** Its place in the results of searching the term with the reading's main words (0 = first). */
  contextRank?: number;
}
/** A Wikipedia article as plain text, split into its lead and sections (reference sections removed). */
export interface WikiPage {
  title: string;
  url: string;
  description: string;
  edited: string | null;
  lead: string;
  sections: { title: string; level: number; text: string }[];
}
/** An offline dictionary entry (WordNet). */
/** A dictionary entry: from Wiktionary when online, or the offline dictionary (WordNet). */
export interface DictEntry {
  word: string;
  entries: {
    pos: string;
    lemma: string;
    senses: {
      def: string;
      examples: string[];
      synonyms: string[];
      antonyms: string[];
      /** Wiktionary only: the subject the sense belongs to ("Chemistry"), its narrower senses, and for an
       * inflected form ("dissolves") the base word. */
      label?: string;
      sub?: string[];
      formOf?: string;
    }[];
  }[];
  synonyms: string[];
  antonyms: string[];
  source?: 'wiktionary' | 'wordnet';
  url?: string;
}

export interface SpeechModel {
  id: string;
  repo: string;
  label: string;
  blurb: string;
  englishOnly: boolean;
  size: number;
  installed: boolean;
  download: { status: string; received: number; total: number; error?: string } | null;
}

export const api: KeaApi = window.api;
