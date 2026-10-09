/**
 * `serve --http --session-idle-sec` tests.
 *
 * The Streamable HTTP server drops sessions that sit idle (default one hour)
 * and answers a stale `Mcp-Session-Id` with the spec's 404 "re-initialize"
 * signal. A client that ignores that signal keeps sending the dead id and
 * stays wedged until it is restarted, so the window is operator-configurable
 * and `0` switches expiry off entirely.
 *
 * Spawns the real built binary and drives it over real HTTP — the same
 * constraint as mcp-http-transport.test.ts, because the engine's lazy
 * `require('../index')` only resolves in the compiled CommonJS build, not
 * under vitest's ESM transform.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { once } from 'events';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const ENDPOINT = '/mcp';

let children: ChildProcess[] = [];
let tempDirs: string[] = [];

/** A freshly indexed tiny project — one server per root, so one root per test. */
async function makeProject(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-http-idle-'));
  tempDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, 'helper.ts'),
    ['export function greetUser(name: string): string {', '  return `hello ${name}`;', '}', ''].join('\n'),
  );
  const { CodeGraph } = await import('../src');
  const cg = await (CodeGraph as typeof import('../src').CodeGraph).init(dir);
  cg.close();
  return dir;
}

interface StartedServer {
  baseUrl: string;
  /** Startup stderr so far, for asserting the logged effective settings. */
  log: () => string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll until `predicate` holds or the budget runs out. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

/** Spawn `serve --http` on an ephemeral port; resolve once it logs its URL. */
async function startServer(projectDir: string, extraArgs: string[] = []): Promise<StartedServer> {
  const child = spawn(
    process.execPath,
    [...WASM_RUNTIME_FLAGS, BIN, 'serve', '--http', '--port', '0', '--path', projectDir, ...extraArgs],
    { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);
  let buf = '';
  const baseUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not announce its port; stderr: ${buf}`)), 30000);
    child.stderr!.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const m = /Streamable HTTP listening on (http:\/\/[^/\s]+)/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    child.on('exit', (code) => reject(new Error(`server exited early (code ${code}); stderr: ${buf}`)));
  });
  // The listening line is announced before the settings lines that follow it,
  // so wait for the idle line too: asserting on the logged config must not race it.
  await waitFor(() => buf.includes('session idle:'), 5000);
  return { baseUrl, log: () => buf };
}

interface ExitResult {
  code: number | null;
  stderr: string;
}

/** Spawn the server expecting it to reject its arguments and exit. */
async function startExpectingExit(projectDir: string, extraArgs: string[]): Promise<ExitResult> {
  const child = spawn(
    process.execPath,
    [...WASM_RUNTIME_FLAGS, BIN, 'serve', '--http', '--port', '0', '--path', projectDir, ...extraArgs],
    { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  const [code] = (await once(child, 'exit')) as [number | null];
  return { code, stderr };
}

interface JsonRpcHttpResult {
  status: number;
  headers: Headers;
  body: any | null;
}

/** POST one JSON-RPC message; returns status + parsed body. */
async function post(baseUrl: string, message: unknown, sessionId?: string): Promise<JsonRpcHttpResult> {
  const res = await fetch(baseUrl + ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

function initializeMessage() {
  return {
    jsonrpc: '2.0' as const,
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'http-idle-test', version: '0.0.0' },
    },
  };
}

const toolsListMessage = { jsonrpc: '2.0' as const, id: 2, method: 'tools/list' };

/** initialize + return the minted session id. */
async function newSession(baseUrl: string): Promise<string> {
  const res = await post(baseUrl, initializeMessage());
  expect(res.status).toBe(200);
  const id = res.headers.get('mcp-session-id');
  expect(id).toBeTruthy();
  return id!;
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }
  }
  children = [];
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

describe('MCP HTTP session expiry', () => {
  it('drops an idle session once the configured window passes, and accepts a fresh initialize', async () => {
    const dir = await makeProject();
    const server = await startServer(dir, ['--session-idle-sec', '2']);
    expect(server.log()).toContain('session idle: 2s');

    const sessionId = await newSession(server.baseUrl);
    const live = await post(server.baseUrl, toolsListMessage, sessionId);
    expect(live.status).toBe(200);

    // Expiry is measured on inactivity, so the wait must send nothing: any
    // probe would refresh lastActivity and postpone the sweep. Each attempt
    // therefore idles for a full window past the 2s deadline before looking.
    let expired: JsonRpcHttpResult | null = null;
    for (let attempt = 0; attempt < 3 && expired === null; attempt++) {
      await sleep(4000);
      const res = await post(server.baseUrl, toolsListMessage, sessionId);
      if (res.status === 404) expired = res;
    }
    expect(expired).not.toBeNull();
    expect(expired!.body.error.message).toContain('re-initialize');

    // The spec's recovery path: a new initialize mints a usable session.
    const replacement = await newSession(server.baseUrl);
    const recovered = await post(server.baseUrl, toolsListMessage, replacement);
    expect(recovered.status).toBe(200);
  }, 60000);

  it('--session-idle-sec 0 keeps an idle session alive past the default-meaningful window', async () => {
    const dir = await makeProject();
    const server = await startServer(dir, ['--session-idle-sec', '0']);
    expect(server.log()).toContain('session idle: never expires');

    const sessionId = await newSession(server.baseUrl);
    await sleep(4000);
    const res = await post(server.baseUrl, toolsListMessage, sessionId);
    expect(res.status).toBe(200);
  }, 60000);

  it('rejects a non-numeric or negative window instead of serving', async () => {
    const dir = await makeProject();

    const notANumber = await startExpectingExit(dir, ['--session-idle-sec', 'abc']);
    expect(notANumber.code).toBe(1);
    expect(notANumber.stderr).toContain('Invalid session idle window');

    const negative = await startExpectingExit(dir, ['--session-idle-sec=-5']);
    expect(negative.code).toBe(1);
    expect(negative.stderr).toContain('Invalid session idle window');
  }, 60000);
});
