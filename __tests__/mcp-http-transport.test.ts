/**
 * MCP Streamable HTTP transport tests (spec revision 2025-06-18).
 *
 * Spawns the real `codegraph serve --http` binary (port 0 → ephemeral, the
 * actual port parsed from the startup log) and drives it over real HTTP with
 * global fetch — the same spawn-based pattern as mcp-initialize.test.ts,
 * because the engine's lazy `require('../index')` only resolves in the
 * compiled CommonJS build, not under vitest's ESM transform.
 *
 * Asserts the wire contract remote clients depend on: initialize mints an
 * `Mcp-Session-Id`, requests require it, unknown ids are the spec's 404
 * re-initialize signal, notifications 202, GET 405, DELETE terminates,
 * batches rejected, and the Origin check (DNS-rebinding mitigation).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { once } from 'events';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const ENDPOINT = '/mcp';

/** Spawn `serve --http` on an ephemeral port; resolve once it logs the URL. */
async function startServer(projectDir: string, extraArgs: string[] = []): Promise<string> {
  const child = spawn(
    process.execPath,
    [...WASM_RUNTIME_FLAGS, BIN, 'serve', '--http', '--port', '0', '--path', projectDir, ...extraArgs],
    { cwd: projectDir, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  children.push(child);
  // The log line is "… listening on http://127.0.0.1:<port>/mcp" — capture the
  // ORIGIN only, the endpoint is appended by post().
  const url = await new Promise<string>((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`server did not announce its port; stderr: ${buf}`)), 20000);
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
  return url;
}

let tempDir: string;
let baseUrl: string;
let plainDir: string; // no .codegraph — for the allowlist server (initialize-only)
let children: ChildProcess[] = [];

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-http-'));
  fs.writeFileSync(
    path.join(tempDir, 'helper.ts'),
    [
      'export function greetUser(name: string): string {',
      '  return `hello ${name}`;',
      '}',
      'export function farewell(name: string): string {',
      '  return greetUser(name) + " bye";',
      '}',
      '',
    ].join('\n'),
  );
  const { CodeGraph } = await import('../src');
  const cg = await (CodeGraph as typeof import('../src').CodeGraph).init(tempDir);
  cg.close();

  // ONE server for the whole suite: HTTP mode is single-writer-per-project
  // (same guard as direct stdio mode), so a server per test would be refused
  // by the writer lock. The shared server also mirrors real usage — many
  // sessions, one engine.
  baseUrl = await startServer(tempDir);
});

afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }
  }
  children = [];
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (plainDir) fs.rmSync(plainDir, { recursive: true, force: true });
});

interface JsonRpcHttpResult {
  status: number;
  headers: Headers;
  body: any | null;
}

/** POST one JSON-RPC message; returns status + parsed body. */
async function post(
  baseUrl: string,
  message: unknown,
  sessionId?: string,
  origin?: string,
): Promise<JsonRpcHttpResult> {
  const res = await fetch(baseUrl + ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    body: JSON.stringify(message),
  });
  const text = await res.text();
  return {
    status: res.status,
    headers: res.headers,
    body: text ? JSON.parse(text) : null,
  };
}

function initializeMessage() {
  return {
    jsonrpc: '2.0' as const,
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'http-test', version: '0.0.0' },
    },
  };
}

/** initialize + return the minted session id (and the server's base URL). */
async function newSession(baseUrl: string): Promise<string> {
  const res = await post(baseUrl, initializeMessage());
  expect(res.status).toBe(200);
  const id = res.headers.get('mcp-session-id');
  expect(id).toBeTruthy();
  return id!;
}

describe('MCP Streamable HTTP transport', () => {
  it('initialize responds 200 with a Mcp-Session-Id and server info', async () => {
    const res = await post(baseUrl, initializeMessage());
    expect(res.status).toBe(200);
    expect(res.body.jsonrpc).toBe('2.0');
    expect(res.body.id).toBe(1);
    expect(res.body.result.protocolVersion).toBeDefined();
    expect(res.body.result.serverInfo.name).toBe('codegraph');
    expect(res.body.result.instructions).toBeTruthy();
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('notifications/initialized returns 202 with no body', async () => {
    const sessionId = await newSession(baseUrl);
    const res = await post(baseUrl, { jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
    expect(res.status).toBe(202);
    expect(res.body).toBeNull();
  });

  it('tools/list requires and honors the session id', async () => {
    const sessionId = await newSession(baseUrl);

    // Missing header on a non-initialize request → 400.
    const missing = await post(baseUrl, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBeDefined();

    // Unknown session id → 404 (the spec's re-initialize signal).
    const bogus = await post(baseUrl, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, 'not-a-real-session-id');
    expect(bogus.status).toBe(404);

    // Valid session → the tool list, with the session + protocol headers.
    const res = await post(baseUrl, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionId);
    expect(res.status).toBe(200);
    const names = (res.body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('codegraph_explore');
    expect(res.headers.get('mcp-session-id')).toBe(sessionId);
    expect(res.headers.get('mcp-protocol-version')).toBeTruthy();
  });

  it('tools/call explore answers from the indexed project', async () => {
    const sessionId = await newSession(baseUrl);
    const res = await post(
      baseUrl,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'codegraph_explore',
          arguments: { query: 'greetUser farewell' },
        },
      },
      sessionId,
    );
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBeFalsy();
    const text = (res.body.result.content as Array<{ type: string; text?: string }>)
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
    expect(text).toContain('greetUser');
  }, 30000);

  it('two clients get independent sessions on one server', async () => {
    const a = await newSession(baseUrl);
    const b = await newSession(baseUrl);
    expect(a).not.toBe(b);
    const resA = await post(baseUrl, { jsonrpc: '2.0', id: 9, method: 'tools/list' }, a);
    const resB = await post(baseUrl, { jsonrpc: '2.0', id: 9, method: 'tools/list' }, b);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
  });

  it('concurrent requests on one session both resolve (id correlation)', async () => {
    const sessionId = await newSession(baseUrl);
    const [a, b] = await Promise.all([
      post(baseUrl, { jsonrpc: '2.0', id: 10, method: 'tools/list' }, sessionId),
      post(baseUrl, { jsonrpc: '2.0', id: 11, method: 'tools/list' }, sessionId),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.id).toBe(10);
    expect(b.body.id).toBe(11);
  });

  it('GET returns 405 (no server-initiated stream) and unknown paths 404', async () => {
    const get = await fetch(baseUrl + ENDPOINT, { method: 'GET' });
    expect(get.status).toBe(405);
    expect(get.headers.get('allow')).toContain('POST');

    const elsewhere = await fetch(baseUrl + '/nope', { method: 'POST', body: '{}' });
    expect(elsewhere.status).toBe(404);
  });

  it('DELETE terminates the session; the next request is a 404', async () => {
    const sessionId = await newSession(baseUrl);
    const del = await fetch(baseUrl + ENDPOINT, {
      method: 'DELETE',
      headers: { 'Mcp-Session-Id': sessionId },
    });
    expect(del.status).toBe(200);

    const after = await post(baseUrl, { jsonrpc: '2.0', id: 12, method: 'tools/list' }, sessionId);
    expect(after.status).toBe(404);
  });

  it('re-initialize on a live session id mints a fresh session', async () => {
    const first = await newSession(baseUrl);
    const res = await post(baseUrl, initializeMessage(), first);
    expect(res.status).toBe(200);
    const second = res.headers.get('mcp-session-id');
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it('rejects JSON-RPC batches (removed in 2025-06-18) and invalid JSON', async () => {
    const sessionId = await newSession(baseUrl);

    const batch = await fetch(baseUrl + ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessionId },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ]),
    });
    expect(batch.status).toBe(400);
    expect((await batch.json()).error.code).toBe(-32600);

    const garbage = await fetch(baseUrl + ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'this is not json',
    });
    expect(garbage.status).toBe(400);
    expect((await garbage.json()).error.code).toBe(-32700);
  });

  it('enforces the Origin allowlist (DNS-rebinding mitigation)', async () => {
    plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-http-plain-'));
    const baseUrl = await startServer(plainDir, ['--allowed-origins', 'https://good.example']);

    // Disallowed Origin → 403.
    const bad = await post(baseUrl, initializeMessage(), undefined, 'https://evil.example');
    expect(bad.status).toBe(403);

    // Allowed Origin → passes.
    const good = await post(baseUrl, initializeMessage(), undefined, 'https://good.example');
    expect(good.status).toBe(200);

    // Loopback Origin always passes; no Origin at all always passes.
    const loopback = await post(baseUrl, initializeMessage(), undefined, 'http://localhost:5173');
    expect(loopback.status).toBe(200);
    const none = await post(baseUrl, initializeMessage());
    expect(none.status).toBe(200);
  });

  it('rejects a null or non-scalar JSON-RPC id instead of parking it (would have hung + killed the session)', async () => {
    const res = await post(baseUrl, { jsonrpc: '2.0', id: null, method: 'tools/list' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32600);
    const res2 = await post(baseUrl, { jsonrpc: '2.0', id: { weird: true }, method: 'tools/list' });
    expect(res2.status).toBe(400);

    // The shared session is unaffected by the rejected messages.
    const sessionId = await newSession(baseUrl);
    const ok = await post(baseUrl, { jsonrpc: '2.0', id: 30, method: 'tools/list' }, sessionId);
    expect(ok.status).toBe(200);
  });

  it('rejects a duplicate in-flight request id on one session', async () => {
    const sessionId = await newSession(baseUrl);
    // tools/list resolves too fast to overlap two POSTs; a real explore query
    // stays in flight long enough for the duplicate check to see it.
    const call = (id: number) =>
      post(baseUrl, {
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'codegraph_explore', arguments: { query: 'greetUser farewell' } },
      }, sessionId);
    const [a, b] = await Promise.all([call(40), call(40)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBe(400);
    expect([a.body.id, b.body.id]).toContain(40);
  });

  it('requires the bearer token when --auth-token is set', async () => {
    plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-http-auth-'));
    const baseUrl = await startServer(plainDir, ['--auth-token', 'sekrit-token']);

    const noToken = await post(baseUrl, initializeMessage());
    expect(noToken.status).toBe(401);

    const wrongToken = await fetch(baseUrl + ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong' },
      body: JSON.stringify(initializeMessage()),
    });
    expect(wrongToken.status).toBe(401);
    expect(wrongToken.headers.get('www-authenticate')).toBe('Bearer');

    const good = await fetch(baseUrl + ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sekrit-token' },
      body: JSON.stringify(initializeMessage()),
    });
    expect(good.status).toBe(200);
    expect(good.headers.get('mcp-session-id')).toBeTruthy();
  });

  it('applies the Origin gate to DELETE too, and 400s an unknown MCP-Protocol-Version', async () => {
    plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-mcp-http-plain2-'));
    const baseUrl = await startServer(plainDir, ['--allowed-origins', 'https://good.example']);

    // Bad Origin on DELETE → 403 (before any session lookup).
    const del = await fetch(baseUrl + ENDPOINT, {
      method: 'DELETE',
      headers: { 'Mcp-Session-Id': 'whatever', Origin: 'https://evil.example' },
    });
    expect(del.status).toBe(403);

    // Unknown protocol version header on POST → 400.
    const res = await fetch(baseUrl + ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': '1999-01-01' },
      body: JSON.stringify(initializeMessage()),
    });
    expect(res.status).toBe(400);

    // A KNOWN version header passes.
    const ok = await fetch(baseUrl + ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'MCP-Protocol-Version': '2025-06-18' },
      body: JSON.stringify(initializeMessage()),
    });
    expect(ok.status).toBe(200);
  });
});
