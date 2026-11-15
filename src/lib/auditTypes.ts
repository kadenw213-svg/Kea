// What the product audit (electron/audit.cjs) sends to its screen.
export type FindingStatus = 'new' | 'planned' | 'accepted' | 'building' | 'done' | 'dismissed';

export interface Finding {
  id: string;
  category: string;
  status: FindingStatus;
  app: string;
  maker: string;
  url: string;
  age: 'newer' | 'established';
  feature: string;
  what: string;
  howItWorks: string;
  keaHas: 'none' | 'partial' | 'full';
  value: number;
  feasibility: 'easy' | 'moderate' | 'hard' | 'not-feasible';
  effort: string;
  approach: string;
  observable: string;
  risk: string;
  sources: string[];
  foundAt: string;
  seenAt: string;
  note?: string;
  plan: { at: string; verdict: string; text: string } | null;
}

export interface AuditRun {
  id: string;
  kind: 'spec' | 'research' | 'plan' | 'thread';
  label: string;
  start: string;
  end: string | null;
  status: 'running' | 'done' | 'failed' | 'stopped';
  step: string;
  note: string;
}

export interface AuditConfig {
  repoPath: string;
  categories: Record<string, boolean>;
  extraTopics: string;
  concurrency: number;
  researchModel: string;
  specModel: string;
  planModel: string;
  maxTurns: number;
  perRun: number;
}

export type ThreadStatus = 'open' | 'exploring' | 'parked' | 'done';
export interface ThreadEntry {
  id: string;
  by: 'owner' | 'claude' | 'finding';
  at: string;
  text: string;
  editedAt?: string;
  finding?: string;
}
export interface IdeaThread {
  id: string;
  title: string;
  status: ThreadStatus;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  entries: ThreadEntry[];
}

export interface AuditState {
  threads: IdeaThread[];
  spec: string;
  specAt: string | null;
  findings: Finding[];
  runs: AuditRun[];
  config: AuditConfig;
  categories: { id: string; label: string }[];
  repo: string;
  busy: boolean;
  lastResearch: string | null;
  folder: string;
}

export interface AuditApi {
  state(): Promise<AuditState>;
  buildSpec(): Promise<{ ok: boolean; error?: string }>;
  research(ids?: string[]): Promise<{ ok: boolean; error?: string; started?: number }>;
  plan(id: string): Promise<{ ok: boolean; error?: string }>;
  stop(): Promise<boolean>;
  setStatus(id: string, status: FindingStatus): Promise<boolean>;
  setNote(id: string, note: string): Promise<boolean>;
  setConfig(patch: Partial<AuditConfig>): Promise<AuditState>;
  thread(op: 'create', a: { title: string; text?: string }): Promise<string>;
  thread(op: 'update', a: { id: string; title?: string; status?: ThreadStatus; pinned?: boolean }): Promise<boolean>;
  thread(op: 'add', a: { id: string; text: string }): Promise<boolean>;
  thread(op: 'editEntry', a: { id: string; entry: string; text: string }): Promise<boolean>;
  thread(op: 'deleteEntry', a: { id: string; entry: string }): Promise<boolean>;
  thread(op: 'link', a: { id: string; finding: string }): Promise<boolean>;
  thread(op: 'delete', a: { id: string }): Promise<boolean>;
  threadAsk(id: string): Promise<{ ok: boolean; error?: string }>;
  openFolder(): Promise<string>;
  openUrl(url: string): Promise<boolean>;
  onChanged(cb: () => void): () => void;
}
