/**
 * git-mirror: the `git-sync` engine.
 *
 * Real temp git repositories (a source worktree, a bare remote, and a mirror
 * clone) exercised in-process — the module is pure git plumbing with no
 * engine dependency, so unlike the MCP suites it needs no spawned binary.
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  GitMirrorConfigError,
  formatSyncLogLine,
  runGitMirrorService,
  runGitMirrorSyncOnce,
  validateMirror,
} from '../src/sync/git-mirror';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

const root = mkdtempSync(path.join(os.tmpdir(), 'codegraph-git-mirror-'));
let scenarioCount = 0;

interface Scenario {
  source: string;
  bare: string;
  mirror: string;
  /** Commit files in the source and push to the bare remote. */
  push(files: Record<string, string>, message: string): void;
}

function makeScenario(): Scenario {
  const id = ++scenarioCount;
  const source = path.join(root, `s${id}`);
  const bare = path.join(root, `r${id}.git`);
  const mirror = path.join(root, `m${id}`);
  mkdirSync(source, { recursive: true });

  git(source, ['init', '-b', 'dev']);
  git(source, ['config', 'user.email', 'mirror@test']);
  git(source, ['config', 'user.name', 'Mirror Test']);
  writeFileSync(path.join(source, 'a.txt'), 'one\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'first']);

  git(source, ['clone', '--bare', '.', bare.replace(/\\/g, '/')]);
  git(source, ['remote', 'add', 'origin', bare.replace(/\\/g, '/')]);
  execFileSync('git', ['clone', bare.replace(/\\/g, '/'), mirror], {
    encoding: 'utf-8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  git(mirror, ['config', 'user.email', 'mirror@test']);
  git(mirror, ['config', 'user.name', 'Mirror Test']);

  return {
    source,
    bare,
    mirror,
    push(files: Record<string, string>, message: string): void {
      for (const [name, content] of Object.entries(files)) {
        writeFileSync(path.join(source, name), content);
      }
      git(source, ['add', '.']);
      git(source, ['commit', '-m', message]);
      git(source, ['push', 'origin', 'dev']);
    },
  };
}

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('git-mirror sync', () => {
  it('fast-forwards onto a new remote commit', async () => {
    const sc = makeScenario();
    sc.push({ 'a.txt': 'two\n' }, 'second');

    const result = await runGitMirrorSyncOnce({ repoPath: sc.mirror });
    expect(result.kind).toBe('updated');
    if (result.kind !== 'updated') return;
    expect(result.applied).toBe('ff');
    expect(result.filesChanged).toBe(1);
    expect(result.subject).toBe('second');
    expect(readFileSync(path.join(sc.mirror, 'a.txt'), 'utf-8')).toBe('two\n');
  });

  it('reports up-to-date when nothing moved', async () => {
    const sc = makeScenario();
    sc.push({ 'b.txt': 'b\n' }, 'second');
    await runGitMirrorSyncOnce({ repoPath: sc.mirror });

    const again = await runGitMirrorSyncOnce({ repoPath: sc.mirror });
    expect(again.kind).toBe('up-to-date');
  });

  it('counts every changed file', async () => {
    const sc = makeScenario();
    sc.push({ 'a.txt': 'x\n', 'c.txt': 'c\n', 'd.txt': 'd\n' }, 'many');

    const result = await runGitMirrorSyncOnce({ repoPath: sc.mirror });
    expect(result.kind === 'updated' && result.filesChanged).toBe(3);
  });

  it('skips a diverged head in ff-only mode (force-push protection)', async () => {
    const sc = makeScenario();
    sc.push({ 'a.txt': 'remote\n' }, 'remote commit');
    // Local commit → mirror head is no longer an ancestor of the remote tip.
    writeFileSync(path.join(sc.mirror, 'local.txt'), 'local\n');
    git(sc.mirror, ['add', '.']);
    git(sc.mirror, ['commit', '-m', 'local commit']);
    const localHead = git(sc.mirror, ['rev-parse', 'HEAD']);

    const result = await runGitMirrorSyncOnce({ repoPath: sc.mirror });
    expect(result.kind).toBe('skipped-diverged');
    // The local head is untouched — the mirror did not move to the remote.
    expect(git(sc.mirror, ['rev-parse', 'HEAD'])).toBe(localHead);
    expect(exists(path.join(sc.mirror, 'local.txt'))).toBe(true);
  });

  it('hard mode resets to the remote tip and keeps untracked files', async () => {
    const sc = makeScenario();
    sc.push({ 'a.txt': 'rewritten\n' }, 'force push');
    writeFileSync(path.join(sc.mirror, 'local.txt'), 'local\n');
    git(sc.mirror, ['add', '.']);
    git(sc.mirror, ['commit', '-m', 'local commit']);
    mkdirSync(path.join(sc.mirror, '.codegraph'), { recursive: true });
    writeFileSync(path.join(sc.mirror, '.codegraph', 'codegraph.db'), 'index');

    const result = await runGitMirrorSyncOnce({ repoPath: sc.mirror, mode: 'hard' });
    expect(result.kind).toBe('updated');
    if (result.kind !== 'updated') return;
    expect(result.applied).toBe('reset');
    expect(git(sc.mirror, ['rev-parse', 'HEAD'])).toBe(
      git(sc.source, ['rev-parse', 'origin/dev'])
    );
    // The local (tracked) commit is gone; the untracked index directory is not.
    expect(exists(path.join(sc.mirror, 'local.txt'))).toBe(false);
    expect(exists(path.join(sc.mirror, '.codegraph', 'codegraph.db'))).toBe(true);
  });

  it('requires an explicit branch on a detached head', async () => {
    const sc = makeScenario();
    git(sc.mirror, ['checkout', '--detach']);

    await expect(
      runGitMirrorSyncOnce({ repoPath: sc.mirror })
    ).rejects.toThrow(GitMirrorConfigError);

    sc.push({ 'a.txt': 'detached\n' }, 'moves on');
    const result = await runGitMirrorSyncOnce({ repoPath: sc.mirror, branch: 'dev' });
    expect(result.kind).toBe('updated');
  });

  it('returns an error result (not a throw) when fetch fails at runtime', async () => {
    const sc = makeScenario();
    git(sc.mirror, ['remote', 'set-url', 'origin', path.join(root, 'no-such-remote.git')]);

    const result = await runGitMirrorSyncOnce({ repoPath: sc.mirror });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('fetch');
    }
  });
});

describe('git-mirror validation (fatal config errors)', () => {
  it('rejects a non-repository', () => {
    const dir = path.join(root, 'not-a-repo');
    mkdirSync(dir, { recursive: true });
    expect(() => validateMirror(dir, 'origin', 'dev')).toThrow(GitMirrorConfigError);
  });

  it('rejects an unknown remote', () => {
    const sc = makeScenario();
    expect(() => validateMirror(sc.mirror, 'upstream', 'dev')).toThrow(/remote 'upstream'/);
  });

  it('rejects a branch that does not exist on the remote', () => {
    const sc = makeScenario();
    expect(() => validateMirror(sc.mirror, 'origin', 'nope')).toThrow(
      /branch 'nope' not found/
    );
  });
});

describe('git-mirror service loop', () => {
  it('applies a pending update on the first tick, logs it, and stops cleanly', async () => {
    const sc = makeScenario();
    sc.push({ 'a.txt': 'service\n' }, 'service update');
    const logs: string[] = [];

    const { started, handle } = runGitMirrorService({
      repoPath: sc.mirror,
      intervalSec: 60,
      log: (line) => logs.push(line),
    });
    await started;

    expect(logs[0]).toContain('watching');
    expect(logs[0]).toContain('origin/dev');
    const updateLine = logs.find((l) => l.includes('->'));
    expect(updateLine).toBeDefined();
    expect(updateLine).toContain('1 file changed');
    expect(updateLine).toContain('"service update"');
    expect(readFileSync(path.join(sc.mirror, 'a.txt'), 'utf-8')).toBe('service\n');

    await handle.stop();
  });

  it('stays quiet on no-op ticks', async () => {
    const sc = makeScenario();
    const logs: string[] = [];
    const { started, handle } = runGitMirrorService({
      repoPath: sc.mirror,
      intervalSec: 60,
      log: (line) => logs.push(line),
    });
    await started;
    // Only the startup line — the up-to-date tick printed nothing.
    expect(logs).toHaveLength(1);
    await handle.stop();
  });
});

describe('git-mirror log line format', () => {
  it('includes timestamp, commits, and file count for updates', () => {
    const line = formatSyncLogLine(
      {
        kind: 'updated',
        from: '1111111111111111111111111111111111111111',
        to: '2222222222222222222222222222222222222222',
        filesChanged: 7,
        subject: 'Merge branch into dev',
        applied: 'ff',
      },
      'dev'
    );
    expect(line).toMatch(/^\[git-sync\] \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} dev: /);
    expect(line).toContain('1111111111 -> 2222222222');
    expect(line).toContain('7 files changed');
    expect(line).toContain('"Merge branch into dev"');
  });
});

function exists(p: string): boolean {
  try {
    readFileSync(p);
    return true;
  } catch {
    return false;
  }
}
