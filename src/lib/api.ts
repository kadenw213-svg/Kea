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

export interface SlateApi {
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
  wikiLookup(query: string, opts?: { lang?: string; max?: number; chars?: number; intro?: boolean }): Promise<WikiArticle[]>;
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
    api: SlateApi;
  }
}

export interface WikiArticle {
  title: string;
  url: string;
  text: string;
  edited: string | null;
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

export const api: SlateApi = window.api;
