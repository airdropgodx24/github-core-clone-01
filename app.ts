// HTTP wiring: one node:http server that routes the four surfaces — git smart HTTP,
// REST v3, GraphQL and MCP — over the shared store, with bearer-token auth and the
// request-id header GitHub clients expect. Handlers stay allocation-light so the
// timed workloads (sequential pushes, shallow clones, issue reads) stay fast.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleMcp } from './mcp.ts';
import { executeGraphQL } from './graphql.ts';
import { infoRefs, receivePack, uploadPack } from './git.ts';
import { handleRest } from './rest.ts';
import { store } from './store.ts';

const MAX_BODY_BYTES = 256 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        rejectBody(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', rejectBody);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...extraHeaders,
  });
  res.end(text);
}

function sendRest(res: ServerResponse, result: { status: number; body: unknown; headers?: Record<string, string> }): void {
  const headers: Record<string, string> = { 'X-GitHub-Request-Id': store.nextRequestId(), ...(result.headers ?? {}) };
  if (result.status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  sendJson(res, result.status, result.body, headers);
}

function authorized(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (token === '') return false;
  const header = req.headers.authorization;
  return typeof header === 'string' && header === `Bearer ${token}`;
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://forge.local');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeURIComponent(gitMatch[1] as string);
    const repoName = decodeURIComponent(gitMatch[2] as string);
    const rest = gitMatch[3] ?? '';
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const repo = store.repoFor(owner, repoName);
    if (repo === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    if (rest === '/info/refs' && method === 'GET') {
      const service = url.searchParams.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'unknown service' });
        return;
      }
      const protocol = req.headers['git-protocol'];
      const version2 = service === 'git-upload-pack' && typeof protocol === 'string' && protocol.includes('version=2');
      const result = infoRefs(repo, service, version2);
      res.writeHead(result.status, { 'Content-Type': result.contentType, 'Content-Length': result.body.length });
      res.end(result.body);
      return;
    }
    if (rest === '/git-upload-pack' && method === 'POST') {
      const body = await readBody(req);
      const protocol = req.headers['git-protocol'];
      const version2 = typeof protocol === 'string' && protocol.includes('version=2');
      const result = uploadPack(repo, body, version2);
      res.writeHead(result.status, { 'Content-Type': result.contentType, 'Content-Length': result.body.length });
      res.end(result.body);
      return;
    }
    if (rest === '/git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      const result = receivePack(repo, body);
      res.writeHead(result.status, { 'Content-Type': result.contentType, 'Content-Length': result.body.length });
      res.end(result.body);
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  if (path === '/api/graphql' || path === '/graphql') {
    if (!authorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ message: 'Bad credentials', errors: [{ message: 'Bad credentials' }] }));
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { message: 'Method Not Allowed' });
      return;
    }
    const raw = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      sendJson(res, 400, { errors: [{ message: 'the request body is not valid JSON' }] });
      return;
    }
    if (Array.isArray(parsed)) {
      const envelopes = parsed.map((entry) =>
        executeGraphQL(typeof entry === 'object' && entry !== null ? (entry as { query?: unknown }) : {}),
      );
      sendJson(res, 200, envelopes);
      return;
    }
    const envelope = executeGraphQL(typeof parsed === 'object' && parsed !== null ? (parsed as { query?: unknown }) : {});
    sendJson(res, 200, envelope);
    return;
  }

  if (path === '/mcp' || path.startsWith('/mcp/')) {
    if (!authorized(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }));
      return;
    }
    if (method === 'GET' || method === 'DELETE') {
      res.writeHead(405, { Allow: 'POST' });
      res.end();
      return;
    }
    const raw = await readBody(req);
    const reply = handleMcp(raw.toString('utf8'));
    if (reply.empty === true) {
      res.writeHead(reply.status, reply.headers ?? {});
      res.end();
      return;
    }
    sendJson(res, reply.status, reply.body, reply.headers ?? {});
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      sendRest(res, { status: 401, body: { message: 'Requires authentication' } });
      return;
    }
    let body: unknown = undefined;
    let bodyMalformed = false;
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      const raw = await readBody(req);
      if (raw.length > 0) {
        try {
          body = JSON.parse(raw.toString('utf8'));
        } catch {
          bodyMalformed = true;
        }
      }
    }
    if (bodyMalformed) {
      sendRest(res, { status: 400, body: { message: 'Problems parsing JSON' } });
      return;
    }
    const host = req.headers.host ?? 'forge.local';
    const origin = `http://${host}`;
    const result = handleRest({
      method,
      segments: path.split('/').filter((segment) => segment !== '').slice(2).map((segment) => decodeURIComponent(segment)),
      query: url.searchParams,
      body,
      origin,
    });
    sendRest(res, result);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Create the forge HTTP server (not yet listening). */
export function createApp(): Server {
  const server = createServer((req, res) => {
    route(req, res).catch(() => {
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          // The socket is already gone; nothing more to do.
        }
      } else {
        res.end();
      }
    });
  });
  server.keepAliveTimeout = 75_000;
  return server;
}
