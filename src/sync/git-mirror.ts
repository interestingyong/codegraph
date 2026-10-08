/**
 * git-mirror: keep a read-only worktree tracking a remote branch.
 *
 * The shared-deployment companion to `serve --http`: the HTTP server owns the
 * index for one project directory, and this module keeps that directory's git
 * content current — `git fetch` + fast-forward on a fixed interval — so every
 * connected MCP client reads the latest code without anyone SSH-ing in to pull.
 * The serve process's own file watcher picks up whatever the merge touches and
 * re-indexes; nothing here touches `.codegraph/` directly.
 *
 * Deliberately narrow: it is a *mirror* keeper, not a general sync tool. The
 * worktree is expected to have no local commits (the deployment clones it
 * read-only). When the remote history was rewritten (force-push) the local
 * head diverges; `mode: 'ff-only'` (default) skips and warns, `mode: 'hard'`
 * resets to the remote tip — the right choice for a throwaway mirror whose
 * remote occasionally force-pushes. Untracked files (`.codegraph/`, build
 * output) always survive; only tracked content is managed.
 *
 * Pure git plumbing — no engine, no index, no watcher dependencies — so it is
 * unit-testable in-process and usable on any repository, indexed or not.
 */

import { execFileSync } from 'child_process';
import * as path from 'path';

/** How a diverged local head is handled. */
export type GitMirrorDivergedMode = 'ff-only' | 'hard';

export interface GitMirrorOptions {
  /** Worktree root of the repository to keep current. */
  repoPath: string;
  /** Remote to fetch from. Default `origin`. */
  remote?: string;
  /**
   * Branch to track on the remote. Default: the worktree's checked-out branch
   * (a detached head requires an explicit `branch`).
   */
  branch?: string;
  /** Diverged-head handling. Default `ff-only` (skip and warn). */
  mode?: GitMirrorDivergedMode;
  /** Seconds between checks in service mode. Default 60. */
  intervalSec?: number;
  /** Log sink; defaults to console.log. One line per event, no ANSI. */
  log?: (line: string) => void;
}

export type GitMirrorSyncResult =
  | { kind: 'up-to-date'; head: string }
  | {
      kind: 'updated';
      from: string;
      to: string;
      filesChanged: number;
      subject: string;
      /** How the update was applied: fast-forward merge or hard reset. */
      applied: 'ff' | 'reset';
    }
  | { kind: 'skipped-diverged'; head: string; remote: string }
  | { kind: 'error'; message: string };

/** Fatal configuration problem (not a repo, unknown remote/branch, …). */
export class GitMirrorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitMirrorConfigError';
  }
}

class GitCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitCommandError';
  }
}

const DEFAULT_INTERVAL_SEC = 60;
const FETCH_TIMEOUT_MS = 120_000;
const GIT_TIMEOUT_MS = 15_000;

/**
 * Run one git command in the repo, returning trimmed stdout.
 * Throws GitCommandError with the cleaned stderr on failure.
 */
function git(repoPath: string, args: string[], timeoutMs: number = GIT_TIMEOUT_MS): string {
  try {
    const out = execFileSync('git', args, {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: timeoutMs,
      windowsHide: true,
      // Never block on a credential prompt — an unattended service must fail
      // fast and retry on the next tick, not hang forever on a hidden prompt.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return (out as unknown as string).trim();
  } catch (err) {
    const stderr =
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr?: unknown }).stderr ?? '').trim()
        : '';
    throw new GitCommandError(stderr || (err instanceof Error ? err.message : String(err)));
  }
}

/** Local timestamp for log lines — `YYYY-MM-DD HH:mm:ss`, scan-friendly. */
function timestamp(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 10);
}

/**
 * Resolve the branch this mirror tracks: explicit option, else the checked-out
 * branch. Throws GitMirrorConfigError when nothing sensible can be resolved —
 * callers treat that as fatal (bad deployment), not retryable.
 */
export function resolveTrackingBranch(repoPath: string, branch: string | undefined): string {
  if (branch) return branch;
  const current = git(repoPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!current || current === 'HEAD') {
    throw new GitMirrorConfigError(
      `detached HEAD in ${repoPath} — pass an explicit --branch to track`
    );
  }
  return current;
}

/**
 * Validate the deployment up front — fatal errors, not per-tick retries:
 * not a work tree, unknown remote, branch absent on the remote. A network
 * failure during validation is deliberately NOT fatal (the ticks retry).
 */
export function validateMirror(repoPath: string, remote: string, branch: string): void {
  let inside: string;
  try {
    inside = git(repoPath, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    throw new GitMirrorConfigError(`${repoPath} is not a git repository`);
  }
  if (inside !== 'true') {
    throw new GitMirrorConfigError(`${repoPath} is not a git work tree`);
  }
  try {
    git(repoPath, ['remote', 'get-url', remote]);
  } catch {
    throw new GitMirrorConfigError(
      `remote '${remote}' not configured in ${repoPath} (git remote -v lists what exists)`
    );
  }
  try {
    const heads = git(
      repoPath,
      ['ls-remote', '--heads', remote, `refs/heads/${branch}`],
      FETCH_TIMEOUT_MS
    );
    if (!heads) {
      throw new GitMirrorConfigError(
        `branch '${branch}' not found on remote '${remote}' — nothing to track`
      );
    }
  } catch (err) {
    if (err instanceof GitCommandError) {
      // Network down at startup: let the loop retry rather than dying.
      return;
    }
    throw err;
  }
}

/**
 * Run a single fetch-and-apply cycle. Never throws for runtime failures
 * (network, lock contention, dirty-tree merge refusal) — those come back as
 * `{ kind: 'error' }` so a service loop can log and retry next tick. Only
 * GitMirrorConfigError (thrown during branch resolution) escapes.
 */
export async function runGitMirrorSyncOnce(
  options: GitMirrorOptions
): Promise<GitMirrorSyncResult> {
  const repoPath = path.resolve(options.repoPath);
  const remote = options.remote ?? 'origin';
  const mode = options.mode ?? 'ff-only';
  const branch = resolveTrackingBranch(repoPath, options.branch);

  let head: string;
  try {
    head = git(repoPath, ['rev-parse', 'HEAD']);
  } catch (err) {
    return { kind: 'error', message: `reading HEAD failed: ${(err as Error).message}` };
  }

  // Fetch the remote branch tip. FETCH_HEAD is the source of truth for what
  // we just fetched (the remote-tracking ref may be stale or absent).
  try {
    git(repoPath, ['fetch', remote, branch, '--quiet'], FETCH_TIMEOUT_MS);
  } catch (err) {
    return { kind: 'error', message: `fetch ${remote}/${branch} failed: ${(err as Error).message}` };
  }

  let remoteTip: string;
  try {
    remoteTip = git(repoPath, ['rev-parse', 'FETCH_HEAD']);
  } catch (err) {
    return { kind: 'error', message: `resolving FETCH_HEAD failed: ${(err as Error).message}` };
  }

  if (head === remoteTip) {
    return { kind: 'up-to-date', head };
  }

  // Can HEAD fast-forward onto the remote tip?
  let headIsAncestor = false;
  try {
    git(repoPath, ['merge-base', '--is-ancestor', head, remoteTip]);
    headIsAncestor = true;
  } catch {
    headIsAncestor = false;
  }

  if (headIsAncestor) {
    try {
      git(repoPath, ['merge', '--ff-only', '--quiet', '--no-edit', remoteTip]);
    } catch (err) {
      return {
        kind: 'error',
        message: `fast-forward merge refused (dirty worktree?): ${(err as Error).message}`,
      };
    }
    return describeUpdate(repoPath, head, remoteTip, 'ff');
  }

  if (mode === 'hard') {
    try {
      git(repoPath, ['reset', '--hard', '--quiet', remoteTip]);
    } catch (err) {
      return { kind: 'error', message: `reset --hard failed: ${(err as Error).message}` };
    }
    return describeUpdate(repoPath, head, remoteTip, 'reset');
  }

  return { kind: 'skipped-diverged', head, remote: remoteTip };
}

/** Collect the post-update summary the log line prints. */
function describeUpdate(
  repoPath: string,
  from: string,
  to: string,
  applied: 'ff' | 'reset'
): GitMirrorSyncResult {
  let filesChanged = 0;
  let subject = '';
  try {
    const changed = git(repoPath, ['diff', '--name-only', from, to]);
    filesChanged = changed ? changed.split('\n').length : 0;
  } catch {
    // Non-fatal: the update itself succeeded.
  }
  try {
    subject = git(repoPath, ['log', '-1', '--format=%s', to]);
  } catch {
    // Non-fatal.
  }
  return { kind: 'updated', from, to, filesChanged, subject, applied };
}

/** Format the one-line log entry for a sync result. */
export function formatSyncLogLine(result: GitMirrorSyncResult, branch: string): string {
  const ts = timestamp();
  switch (result.kind) {
    case 'up-to-date':
      return `[git-sync] ${ts} ${branch}: up to date at ${shortSha(result.head)}`;
    case 'updated': {
      const how = result.applied === 'reset' ? 'reset' : 'ff';
      const subject = result.subject ? ` "${result.subject}"` : '';
      return `[git-sync] ${ts} ${branch}: ${shortSha(result.from)} -> ${shortSha(result.to)} (${result.filesChanged} file${result.filesChanged === 1 ? '' : 's'} changed, ${how})${subject}`;
    }
    case 'skipped-diverged':
      return `[git-sync] ${ts} ${branch}: DIVERGED local ${shortSha(result.head)} vs remote ${shortSha(result.remote)} — not fast-forwardable; pass --mode hard to reset to the remote tip`;
    case 'error':
      return `[git-sync] ${ts} ${branch}: ERROR ${result.message}`;
  }
}

export interface GitMirrorServiceHandle {
  /** Stop after the current tick and resolve once the loop has exited. */
  stop(): Promise<void>;
}

/**
 * Run the sync loop forever (default 60s interval). Each tick awaits the
 * previous one, so a slow fetch delays — never overlaps — the next.
 *
 * - Runtime failures (fetch error, merge refused) are logged and retried on
 *   the next tick; a config error rejects `started` and stops the loop.
 * - No-op ticks are silent — an entry per *change* is the audit trail the
 *   deployment wants; an entry per minute is noise.
 */
export function runGitMirrorService(options: GitMirrorOptions): {
  started: Promise<void>;
  handle: GitMirrorServiceHandle;
} {
  const repoPath = path.resolve(options.repoPath);
  const remote = options.remote ?? 'origin';
  const mode = options.mode ?? 'ff-only';
  const intervalSec = Math.max(1, options.intervalSec ?? DEFAULT_INTERVAL_SEC);
  const log = options.log ?? ((line: string) => console.log(line));

  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveStopped!: () => void;
  const stoppedPromise = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  let resolveStarted!: () => void;
  let rejectStarted!: (err: Error) => void;
  const started = new Promise<void>((resolve, reject) => {
    resolveStarted = resolve;
    rejectStarted = reject;
  });

  const tick = async (branch: string): Promise<void> => {
    if (stopped) {
      resolveStopped();
      return;
    }
    const result = await runGitMirrorSyncOnce({ ...options, branch });
    if (result.kind !== 'up-to-date') {
      log(formatSyncLogLine(result, branch));
    }
    resolveStarted();
    if (stopped) {
      resolveStopped();
      return;
    }
    // Refed timer: it is what keeps the service process alive between ticks.
    timer = setTimeout(() => void tick(branch), intervalSec * 1000);
  };

  void (async () => {
    let branch: string;
    try {
      branch = resolveTrackingBranch(repoPath, options.branch);
      validateMirror(repoPath, remote, branch);
    } catch (err) {
      stopped = true;
      rejectStarted(err instanceof Error ? err : new Error(String(err)));
      resolveStopped();
      return;
    }
    log(
      `[git-sync] ${timestamp()} watching ${repoPath}: ${remote}/${branch} every ${intervalSec}s (mode: ${mode})`
    );
    await tick(branch);
  })();

  return {
    started,
    handle: {
      stop: async () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        resolveStopped();
        await stoppedPromise;
      },
    },
  };
}
