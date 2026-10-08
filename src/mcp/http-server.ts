/**
 * MCP Streamable HTTP transport — spec revision 2025-06-18.
 *
 * Runs the same per-connection {@link MCPSession} logic as the stdio server,
 * but over HTTP so remote MCP clients (DSH's streamable-http transport,
 * mcp-inspector, browser tooling) can reach a centrally-deployed CodeGraph
 * without spawning a local process.
 *
 * Wire behavior (all on one endpoint, default `/mcp`):
 *
 *   POST   — one JSON-RPC 2.0 message per request body. The server replies
 *            `application/json` (a single-response Streamable HTTP reply —
 *            always valid when no streaming is needed) or `202 Accepted` for
 *            notifications. An `initialize` request mints a NEW session and
 *            returns it in the `Mcp-Session-Id` response header; every other
 *            request must carry that header. An unknown/expired id is a 404 —
 *            the spec's signal for the client to re-initialize.
 *   GET    — 405. This server never opens a server→client SSE stream, so
 *            server-initiated requests (`roots/list`) are unavailable; the
 *            session code already falls back to the process cwd / `--path`.
 *   DELETE — terminates the session.
 *
 * Not a JSON-RPC batch endpoint: batching was removed in the 2025-06-18
 * revision, and array bodies are rejected with 400.
 *
 * Concurrency: one HTTP session = one {@link MCPSession} = one transport,
 * but requests may arrive concurrently (HTTP clients pipeline). Replies are
 * correlated by JSON-RPC id, so each POST resolves against its own pending
 * entry — the same N-sessions-to-one-engine shape the daemon uses, minus the
 * socket. The heavyweight state (CodeGraph, watcher, ToolHandler) lives in
 * the shared {@link MCPEngine} passed in by the caller.
 *
 * Security defaults: binds 127.0.0.1 (pass `host: '0.0.0.0'` to expose), and
 * when an `Origin` header is present it must be localhost/same-host or in
 * `allowedOrigins` (`'*'` disables the check) — the spec's DNS-rebinding
 * mitigation. Non-browser clients (curl, the MCP SDKs) send no Origin and
 * always pass.
 */

import * as http from 'http';
import { randomUUID, timingSafeEqual } from 'crypto';
import {
  ErrorCodes,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcResponse,
  JsonRpcTransport,
  MessageHandler,
} from './transport';
import { MCPSession } from './session';
import { MCPEngine } from './engine';

/** Default bind address — loopback only unless the operator opts into exposure. */
const DEFAULT_HOST = '127.0.0.1';
/** Default port for `codegraph serve --http`. */
const DEFAULT_PORT = 3916;
/** Idle sessions are swept after this long (spec leaves expiry to the server). */
const DEFAULT_SESSION_IDLE_MS = 60 * 60 * 1000;
/** How often the idle sweeper runs. */
const SWEEP_INTERVAL_MS = 60 * 1000;
/** Request-body cap — tool calls carry symbol names, never megabytes. */
const MAX_BODY_BYTES = 10 * 1024 * 1024;
/** Server-side guard so a wedged handler can't hold an HTTP response forever.
 * Generous by design: a first explore may wait on catch-up sync.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

/** Methods this endpoint supports, for every Allow header we emit. */
const ALLOWED_METHODS = 'DELETE, OPTIONS, POST';

/** Raised by {@link withTimeout} — distinguishes a wedged handler (session
 *  is terminated) from a thrown one (session survives, stdio parity). */
class RequestTimeoutError extends Error {}

/** Where the HTTP server is reachable after `start()` resolves. */
export interface HttpListenAddress {
  host: string;
  port: number;
}

export interface McpHttpServerOptions {
  /** Bind address. Default `127.0.0.1`; `0.0.0.0` exposes on every interface. */
  host?: string;
  /** Listen port. Default {@link DEFAULT_PORT}; `0` picks a free ephemeral port. */
  port?: number;
  /** Endpoint path. Default `/mcp`. Requests elsewhere get a plain 404. */
  endpoint?: string;
  /**
   * Allowed `Origin` header values (browser/DNS-rebinding protection). When a
   * request carries an `Origin`, it must match this list or be loopback.
   * `['*']` disables validation. Non-browser clients send no Origin and
   * always pass.
   */
  allowedOrigins?: string[];
  /**
   * Bearer token required on every state-touching request (POST/DELETE) as
   * `Authorization: Bearer <token>`. Strongly recommended whenever the server
   * is bound to a non-loopback address: HTTP mode changes stdio's
   * trusted-local-client model to whoever can reach the port.
   */
  authToken?: string;
  /** Idle session lifetime. Default 1 hour. */
  sessionIdleMs?: number;
  /** Per-request server-side timeout. Default 10 minutes. */
  requestTimeoutMs?: number;
  /** Project root hint, equivalent to stdio `serve --mcp --path`. */
  explicitProjectPath?: string | null;
}

/**
 * One session's transport: the HTTP server hands it parsed POST bodies via
 * {@link deliver}; replies flow back through `sendResult`/`sendError` and are
 * correlated to the waiting POST by JSON-RPC id.
 */
class HttpSessionTransport implements JsonRpcTransport {
  private handler: MessageHandler | null = null;
  private readonly pending = new Map<
    string | number,
    { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void }
  >();
  private stopped = false;
  /** Updated on every delivered message; the sweeper expires on this. */
  lastActivityMs = Date.now();

  start(handler: MessageHandler): void {
    this.handler = handler;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const err = new Error('session closed');
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  /**
   * Deliver one parsed JSON-RPC message. Resolves with the response for a
   * REQUEST (once the session calls `sendResult`/`sendError` for its id), or
   * with `null` immediately for a NOTIFICATION (202 path).
   */
  deliver(message: JsonRpcRequest | JsonRpcNotification): Promise<JsonRpcResponse | null> {
    this.lastActivityMs = Date.now();
    // Capture once — TS can't narrow this.handler across closures.
    const handler = this.handler;
    if (!handler) return Promise.reject(new Error('transport not started'));
    if (this.stopped) return Promise.reject(new Error('session closed'));

    if (!('id' in message)) {
      // Notification — the session processes it fire-and-forget.
      void Promise.resolve(handler(message)).catch(() => { /* never fail the 202 */ });
      return Promise.resolve(null);
    }

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      this.pending.set(message.id, { resolve, reject });
      Promise.resolve(handler(message)).catch((err) => {
        const p = this.pending.get(message.id);
        if (p) {
          this.pending.delete(message.id);
          p.reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  // ---- JsonRpcTransport ----

  send(response: JsonRpcResponse): void {
    this.resolvePending(response);
  }

  /** Whether a request id is already awaiting its reply (duplicate guard). */
  hasPendingId(id: string | number): boolean {
    return this.pending.has(id);
  }

  sendResult(id: string | number, result: unknown): void {
    this.resolvePending({ jsonrpc: '2.0', id, result });
  }

  sendError(id: string | number | null, code: number, message: string, data?: unknown): void {
    this.resolvePending({ jsonrpc: '2.0', id, error: { code, message, data } });
  }

  /** Client-bound notifications have no channel in single-response mode. */
  notify(): void {
    /* no-op */
  }

  /**
   * Server→client requests (`roots/list`) need a stream we don't open.
   * Rejecting makes the session fall back to cwd / `--path` — the documented
   * behavior for transports without a server-initiated channel.
   */
  request(): Promise<never> {
    return Promise.reject(
      new Error('server→client requests are unsupported over the Streamable HTTP single-response transport'),
    );
  }

  private resolvePending(response: JsonRpcResponse): void {
    if (response.id === null || response.id === undefined) return;
    const p = this.pending.get(response.id);
    if (p) {
      this.pending.delete(response.id);
      p.resolve(response);
    }
  }
}

interface RegisteredSession {
  id: string;
  transport: HttpSessionTransport;
  session: MCPSession;
  /** Protocol version echoed in the initialize result, re-emitted as a header. */
  protocolVersion?: string;
}

/**
 * Streamable HTTP MCP server. Owns the HTTP listener, the session registry,
 * and the idle sweeper; the engine is borrowed (the caller keeps it alive and
 * stops it after `stop()`).
 */
export class McpHttpServer {
  private readonly engine: MCPEngine;
  private readonly opts: Required<
    Pick<McpHttpServerOptions, 'host' | 'port' | 'endpoint' | 'sessionIdleMs' | 'requestTimeoutMs'>
  > &
    McpHttpServerOptions;
  private server: http.Server | null = null;
  private sweeper: NodeJS.Timeout | null = null;
  private readonly sessions = new Map<string, RegisteredSession>();
  private listenAddress: HttpListenAddress | null = null;
  private closed = false;

  constructor(engine: MCPEngine, opts: McpHttpServerOptions = {}) {
    this.engine = engine;
    this.opts = {
      host: opts.host ?? DEFAULT_HOST,
      port: opts.port ?? DEFAULT_PORT,
      endpoint: normalizeEndpoint(opts.endpoint ?? '/mcp'),
      sessionIdleMs: opts.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS,
      requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      allowedOrigins: opts.allowedOrigins,
      authToken: opts.authToken,
      explicitProjectPath: opts.explicitProjectPath ?? null,
    };
  }

  /**
   * Protocol revisions this server recognizes in the `MCP-Protocol-Version`
   * request header. Unknown values are a 400 per spec. The server still
   * negotiates 2024-11-05 in the initialize RESULT (session.ts's
   * PROTOCOL_VERSION) — transport and protocol revisions are independent
   * axes, and responding with a supported older revision is spec-sanctioned.
   * Note for clients on pre-2025-06-18 revisions: JSON-RPC batching, legal
   * then, is rejected here with 400 (batching was removed in 2025-06-18 and
   * no streamable-http client of that era exists).
   */
  private static readonly KNOWN_PROTOCOL_VERSIONS = new Set([
    '2024-11-05',
    '2025-03-26',
    '2025-06-18',
    '2025-11-25',
  ]);

  /** Start listening. Resolves with the actual address (port 0 → ephemeral). */
  start(): Promise<HttpListenAddress> {
    if (this.server) return Promise.resolve(this.listenAddress!);
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          const message = err instanceof Error ? err.message : String(err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
          }
          res.end(JSON.stringify({ error: message }));
        });
      });
      server.on('error', reject);
      server.listen(this.opts.port, this.opts.host, () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error(`unexpected listen address: ${String(addr)}`));
          return;
        }
        this.server = server;
        this.listenAddress = { host: this.opts.host, port: addr.port };
        this.closed = false; // start-after-stop must leave a stoppable server (B4)
        this.sweeper = setInterval(() => this.sweepIdleSessions(), SWEEP_INTERVAL_MS);
        this.sweeper.unref();
        resolve(this.listenAddress);
      });
    });
  }

  /** Stop the listener and terminate every session. Idempotent. */
  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    for (const s of this.sessions.values()) {
      s.transport.stop();
      s.session.stop();
    }
    this.sessions.clear();
    await new Promise<void>((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      // In-flight keep-alive sockets shouldn't hold the close open.
      this.server.closeAllConnections?.();
    });
    this.server = null;
  }

  /** Actual listen address — only meaningful after `start()`. */
  address(): HttpListenAddress | null {
    return this.listenAddress;
  }

  /** Live session count (tests / health checks). */
  sessionCount(): number {
    return this.sessions.size;
  }

  // ---- internals ----

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    const corsHeaders = this.corsHeadersFor(origin);
    if (corsHeaders) Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));

    if (req.method === 'OPTIONS') {
      // CORS preflight — touches no state, needs no auth.
      res.writeHead(204, { Allow: ALLOWED_METHODS });
      res.end();
      return;
    }

    const url = (req.url ?? '/').split('?')[0];
    if (url !== this.opts.endpoint) {
      res.writeHead(404, jsonHeaders());
      res.end(JSON.stringify({ error: `unknown endpoint; the MCP endpoint is ${this.opts.endpoint}` }));
      return;
    }

    // Auth gate — applies to every state-touching method (POST/DELETE). The
    // trust model changed with the transport: stdio's client is the local
    // agent, HTTP's is whoever can reach the port.
    if (this.opts.authToken !== undefined && !this.bearerMatches(req)) {
      res.writeHead(401, { ...jsonHeaders(), 'WWW-Authenticate': 'Bearer' });
      res.end(JSON.stringify({ error: 'missing or invalid Authorization bearer token' }));
      return;
    }

    // Origin gate — the spec's DNS-rebinding mitigation, validated on ALL
    // incoming connections (a rebound page can fire blind DELETEs too).
    if (origin !== undefined && !this.originAllowed(origin)) {
      res.writeHead(403, jsonHeaders());
      res.end(JSON.stringify({ error: `Origin ${origin} is not allowed` }));
      return;
    }

    // Protocol-version gate — an unknown MCP-Protocol-Version is a 400 (spec
    // MUST). Absent is fine: clients that never re-send it rely on the
    // initialize result, which is spec-sanctioned.
    const protoHeader = header(req, 'mcp-protocol-version');
    if (protoHeader !== undefined && !McpHttpServer.KNOWN_PROTOCOL_VERSIONS.has(protoHeader)) {
      res.writeHead(400, jsonHeaders());
      res.end(JSON.stringify({ error: `unsupported MCP-Protocol-Version: ${protoHeader}` }));
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      // No server→client stream: the spec's documented opt-out.
      res.writeHead(405, { ...jsonHeaders(), Allow: ALLOWED_METHODS });
      res.end(JSON.stringify({ error: 'this server does not open server-initiated streams' }));
      return;
    }

    if (req.method === 'DELETE') {
      const sessionId = header(req, 'mcp-session-id');
      if (!sessionId) {
        res.writeHead(400, jsonHeaders());
        res.end(JSON.stringify({ error: 'Mcp-Session-Id header is required' }));
        return;
      }
      const entry = this.sessions.get(sessionId);
      if (!entry) {
        res.writeHead(404, jsonHeaders());
        res.end(JSON.stringify({ error: 'session not found or expired' }));
        return;
      }
      this.terminateSession(sessionId);
      res.writeHead(200, jsonHeaders());
      res.end('{}');
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { ...jsonHeaders(), Allow: ALLOWED_METHODS });
      res.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }

    // ---- POST: one JSON-RPC message ----

    const body = await this.readBody(req, res);
    if (body === null) return; // readBody already responded (413 / read error)
    let message: unknown;
    try {
      message = JSON.parse(body.toString('utf8'));
    } catch {
      res.writeHead(400, jsonHeaders());
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: ErrorCodes.ParseError, message: 'invalid JSON body' },
        }),
      );
      return;
    }
    if (Array.isArray(message)) {
      // Batching was removed in protocol revision 2025-06-18.
      res.writeHead(400, jsonHeaders());
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: ErrorCodes.InvalidRequest, message: 'JSON-RPC batching is not supported' },
        }),
      );
      return;
    }
    if (!isValidMessage(message)) {
      res.writeHead(400, jsonHeaders());
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: ErrorCodes.InvalidRequest, message: 'not a valid JSON-RPC message' },
        }),
      );
      return;
    }

    const requestId: string | number | null = 'id' in message ? message.id : null;
    const isInitialize = message.method === 'initialize' && 'id' in message;
    let entry: RegisteredSession;

    if (isInitialize) {
      // A fresh session per initialize — re-initialization is a NEW session,
      // exactly like a new socket connection on the daemon.
      entry = this.createSession();
    } else {
      const sessionId = header(req, 'mcp-session-id');
      if (!sessionId) {
        res.writeHead(400, jsonHeaders());
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: requestId,
            error: {
              code: ErrorCodes.InvalidRequest,
              message: 'Mcp-Session-Id header is required (initialize first)',
            },
          }),
        );
        return;
      }
      const existing = this.sessions.get(sessionId);
      if (!existing) {
        // The spec's recovery signal: the client should re-initialize.
        res.writeHead(404, jsonHeaders());
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: requestId,
            error: { code: ErrorCodes.InvalidRequest, message: 'session not found or expired; re-initialize' },
          }),
        );
        return;
      }
      entry = existing;
    }

    // A duplicate in-flight id would overwrite its pending entry and hang the
    // first POST until the timeout killed the session — refuse instead.
    if (requestId !== null && entry.transport.hasPendingId(requestId)) {
      res.writeHead(400, jsonHeaders());
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          error: {
            code: ErrorCodes.InvalidRequest,
            message: `request id ${JSON.stringify(requestId)} is already in flight on this session`,
          },
        }),
      );
      return;
    }

    // The transport's sendResult/sendError resolve this promise.
    let response: JsonRpcResponse | null;
    try {
      response = await withTimeout(
        entry.transport.deliver(message),
        this.opts.requestTimeoutMs,
        `request timed out after ${this.opts.requestTimeoutMs}ms`,
      );
    } catch (err) {
      const errText = err instanceof Error ? err.message : String(err);
      if (err instanceof RequestTimeoutError) {
        // A wedged handler leaves the session's state unknowable — terminate
        // so the client gets a clean 404 re-initialize signal on its next
        // request rather than repeated 10-minute hangs.
        this.terminateSession(entry.id);
        res.writeHead(504, sessionHeaders(entry, jsonHeaders()));
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: requestId,
            error: { code: ErrorCodes.InternalError, message: errText },
          }),
        );
        return;
      }
      if (/session closed/.test(errText)) {
        res.writeHead(404, sessionHeaders(entry, jsonHeaders()));
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: requestId,
            error: { code: ErrorCodes.InternalError, message: errText },
          }),
        );
        return;
      }
      // A thrown handler is a single bad request, not a dead session — stdio
      // answers InternalError and keeps serving; match that here.
      res.writeHead(500, sessionHeaders(entry, jsonHeaders()));
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: requestId,
          error: { code: ErrorCodes.InternalError, message: errText },
        }),
      );
      return;
    }

    if (response === null) {
      // Notification → 202, no body.
      res.writeHead(202, sessionHeaders(entry, jsonHeaders()));
      res.end();
      return;
    }

    if (isInitialize) {
      const negotiated = (response.result as { protocolVersion?: string } | undefined)?.protocolVersion;
      if (negotiated) entry.protocolVersion = negotiated;
    }

    res.writeHead(200, sessionHeaders(entry, jsonHeaders()));
    res.end(JSON.stringify(response));
  }

  private createSession(): RegisteredSession {
    const id = randomUUID();
    const transport = new HttpSessionTransport();
    const session = new MCPSession(transport, this.engine, {
      explicitProjectPath: this.opts.explicitProjectPath,
    });
    session.start();
    const entry: RegisteredSession = { id, transport, session };
    this.sessions.set(id, entry);
    return entry;
  }

  private terminateSession(id: string): void {
    const entry = this.sessions.get(id);
    if (!entry) return;
    this.sessions.delete(id);
    entry.transport.stop();
    entry.session.stop();
  }

  private sweepIdleSessions(): void {
    const now = Date.now();
    for (const [id, entry] of this.sessions) {
      if (now - entry.transport.lastActivityMs > this.opts.sessionIdleMs) {
        this.terminateSession(id);
      }
    }
  }

  /**
   * Origin check (spec-mandated DNS-rebinding mitigation). No `Origin` header
   * (curl, MCP SDKs) never reaches here — callers gate on presence. Browsers
   * must be loopback or appear in the allowlist; `['*']` disables the check.
   *
   * Deliberately NO comparison against the request's own Host header: under
   * classic rebinding the attacker's hostname appears in BOTH Origin and
   * Host, so matching them admits exactly the attack this check exists to
   * stop. A legit browser page on the deployed host can't read responses
   * without an allowlist entry anyway (no ACAO emitted), so the comparison
   * would only have added attack surface.
   */
  private originAllowed(origin: string): boolean {
    const allow = this.opts.allowedOrigins;
    if (allow?.includes('*')) return true;
    if (allow?.includes(origin)) return true;
    try {
      const hostname = new URL(origin).hostname;
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
      const boundHost = this.listenAddress?.host;
      // The address the operator explicitly bound (a named interface, not a
      // rebound DNS name) is trusted for same-machine browser tooling.
      if (boundHost && boundHost !== '0.0.0.0' && hostname === boundHost) return true;
    } catch {
      /* malformed Origin falls through to reject */
    }
    return false;
  }

  /** Constant-time bearer-token comparison for the auth gate. */
  private bearerMatches(req: http.IncomingMessage): boolean {
    const expected = this.opts.authToken;
    if (expected === undefined) return true;
    const auth = header(req, 'authorization');
    if (!auth || !auth.startsWith('Bearer ')) return false;
    const presented = Buffer.from(auth.slice('Bearer '.length), 'utf8');
    const wanted = Buffer.from(expected, 'utf8');
    return presented.length === wanted.length && timingSafeEqual(presented, wanted);
  }

  /**
   * Read the request body with a size cap. Over-limit answers 413 itself and
   * returns null (the caller must stop); a read error answers 400 the same
   * way. Everything else resolves with the buffered body.
   */
  private async readBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<Buffer | null> {
    try {
      return await readBodyWithLimit(req);
    } catch (err) {
      const overLimit = err instanceof Error && err.message.includes('exceeds');
      res.writeHead(overLimit ? 413 : 400, jsonHeaders());
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      return null;
    }
  }

  /** CORS headers when an allowlist is configured; otherwise none. */
  private corsHeadersFor(origin: string | undefined): Record<string, string> | null {
    const allow = this.opts.allowedOrigins;
    if (!allow || allow.length === 0) return null;
    if (!origin) return {
      'Access-Control-Allow-Origin': allow.includes('*') ? '*' : (allow[0] ?? '*'),
      'Access-Control-Allow-Methods': 'DELETE, GET, OPTIONS, POST',
      'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Authorization',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    };
    if (allow.includes('*') || allow.includes(origin)) return {
      'Access-Control-Allow-Origin': allow.includes('*') ? '*' : origin,
      'Access-Control-Allow-Methods': 'DELETE, GET, OPTIONS, POST',
      'Access-Control-Allow-Headers': 'Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Authorization',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    };
    return null;
  }
}

// ---- helpers ----

function normalizeEndpoint(endpoint: string): string {
  if (!endpoint.startsWith('/')) return '/' + endpoint;
  return endpoint;
}

function jsonHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' };
}

/** Headers every session-scoped response carries (session id + protocol version). */
function sessionHeaders(entry: RegisteredSession, base: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...base, 'Mcp-Session-Id': entry.id };
  if (entry.protocolVersion) h['MCP-Protocol-Version'] = entry.protocolVersion;
  return h;
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

async function readBodyWithLimit(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let destroyed = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        destroyed = true;
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!destroyed) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function isValidMessage(m: unknown): m is JsonRpcRequest | JsonRpcNotification {
  if (!m || typeof m !== 'object') return false;
  const msg = m as { jsonrpc?: unknown; method?: unknown; id?: unknown };
  if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return false;
  // A null/non-scalar id can never be correlated to a reply — over stdio the
  // response simply went to the stream, but here it would park a pending
  // entry until the request timeout killed the whole session.
  if ('id' in msg && (msg.id === null || (typeof msg.id !== 'string' && typeof msg.id !== 'number'))) {
    return false;
  }
  return true;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new RequestTimeoutError(message)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
