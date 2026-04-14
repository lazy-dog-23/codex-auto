export type DiagnosticSeverity = 'info' | 'warn' | 'error';

export interface DiagnosticIssue {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  details?: string;
  path?: string;
}

export interface CommandExecution {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface FileSnapshot {
  path: string;
  exists: boolean;
  kind?: 'file' | 'directory';
}

export interface CycleLockRecord {
  owner: string;
  command: string;
  pid: number;
  hostname: string;
  started_at: string;
}

export interface CycleLockInspection {
  path: string;
  exists: boolean;
  stale: boolean;
  reason?: string;
  record?: CycleLockRecord;
}

export interface CycleLockHandle {
  path: string;
  record: CycleLockRecord;
  staleAfterMs: number;
  release: () => Promise<void>;
}

export interface GitRepositoryInfo {
  path: string;
  gitDir: string;
  commonGitDir: string;
  head: string | null;
  dirty: boolean;
  statusLines: string[];
  probeMode?: 'git' | 'filesystem';
  stable?: boolean;
  transient?: boolean;
  reason?: string;
  attempts?: number;
  managedDirtyPaths?: string[];
  unmanagedDirtyPaths?: string[];
  managedControlSurfaceOnly?: boolean;
}

export interface WorktreeSummary {
  path: string;
  repoRoot: string;
  commonGitDir: string;
  branch: string | null;
  head: string | null;
  dirty: boolean;
  statusLines: string[];
  probeMode?: 'git' | 'filesystem';
  stable?: boolean;
  transient?: boolean;
  reason?: string;
  attempts?: number;
  managedDirtyPaths?: string[];
  unmanagedDirtyPaths?: string[];
  managedControlSurfaceOnly?: boolean;
}

export interface BackgroundWorktreePreparation {
  action: 'created' | 'validated' | 'aligned';
  repoRoot: string;
  backgroundPath: string;
  branch: string;
  head: string;
  worktree: WorktreeSummary;
}
