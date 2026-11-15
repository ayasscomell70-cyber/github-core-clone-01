// The forge's HTTP server: one Node http server routing every surface.
//
//   GET  /healthz                                  the env's boot probe
//   /<owner>/<repo>.git/info/refs                  git smart-HTTP advertisements
//   /<owner>/<repo>.git/git-upload-pack            git fetch / ls-refs
//   /<owner>/<repo>.git/git-receive-pack           git push
//   /api/v3/...                                    GitHub REST v3
//   /api/graphql                                   GraphQL v4
//   /mcp                                           MCP (JSON-RPC 2.0 Streamable HTTP)
//
// Every response carries X-GitHub-Request-Id (set here, before dispatch) and every
// JSON reply is application/json. A request that matches nothing is a JSON 404.
// A handler never crashes the server: an unexpected throw is a 500 JSON body.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { executeGraphQL } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, sendJson as sendGitJson } from './githttp.ts';
import { authedUser, sendError, sendJson, type Ctx } from './httputil.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { nextRequestId } from './store.ts';

/** Bodies larger than this are refused with 413 (packs stay far below it). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Read a request body whole, or null when it is over the cap. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let over = false;
    req.on('data', (chunk: Buffer) => {
      if (over) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        over = true;
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks));
    });
    req.on('error', () => resolve(over ? null : Buffer.concat(chunks)));
  });
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function originOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Build the context the JSON handlers share. */
function jsonCtx(
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: Buffer | null,
): Ctx {
  let body: unknown;
  let bodyMalformed = false;
  if (rawBody !== null && rawBody.length > 0) {
    try {
      body = JSON.parse(rawBody.toString('utf8')) as unknown;
    } catch {
      bodyMalformed = true;
    }
  }
  return {
    req,
    res,
    user: authedUser(req),
    body,
    bodyMalformed,
    query: queryOf(req),
    origin: originOf(req),
  };
}

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = pathOf(req);
  const method = req.method ?? 'GET';
  const segments = path.split('/').filter((segment) => segment !== '');

  // The env's boot check calls this twice: 200 {"ok":true}.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  const rawBody = needsBody ? await readBody(req) : Buffer.alloc(0);
  if (rawBody === null) {
    sendError(res, 413, 'Request body too large');
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql') {
    if (method !== 'POST') {
      sendError(res, 404, 'Not Found');
      return;
    }
    const ctx = jsonCtx(req, res, rawBody);
    if (ctx.user === null) {
      sendError(res, 401, 'Requires authentication');
      return;
    }
    if (ctx.bodyMalformed) {
      sendJson(res, 400, { errors: [{ message: 'Parse error' }] });
      return;
    }
    sendJson(res, 200, executeGraphQL(ctx.body));
    return;
  }

  // MCP.
  if (path === '/mcp') {
    if (method !== 'POST') {
      sendError(res, 404, 'Not Found');
      return;
    }
    const ctx = jsonCtx(req, res, rawBody);
    if (ctx.user === null) {
      sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } });
      return;
    }
    if (ctx.bodyMalformed) {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const outcome = handleMcp(ctx.body);
    if (outcome.body === null) {
      res.writeHead(outcome.status);
      res.end();
      return;
    }
    sendJson(res, outcome.status, outcome.body);
    return;
  }

  // Git smart HTTP: /<owner>/<repo>.git/<service>.
  if (segments.length >= 2 && segments[1]!.endsWith('.git')) {
    const owner = decodeSegment(segments[0]!);
    const repoName = decodeSegment(segments[1]!.slice(0, -4));
    const service = segments[2] ?? '';
    if (service === 'info' && segments[3] === 'refs' && method === 'GET') {
      const query = queryOf(req);
      const serviceName = query.get('service') ?? '';
      handleInfoRefs(req, res, owner, repoName, serviceName, query);
      return;
    }
    if (service === 'git-upload-pack' && method === 'POST') {
      handleUploadPack(req, res, owner, repoName, rawBody);
      return;
    }
    if (service === 'git-receive-pack' && method === 'POST') {
      handleReceivePack(req, res, owner, repoName, rawBody);
      return;
    }
    sendGitJson(res, 404, { message: 'Not Found' });
    return;
  }

  // REST v3: /api/v3/... (segments[0] is 'api', segments[1] is 'v3').
  if (segments.length >= 1 && segments[0] === 'api' && (segments[1] === 'v3' || segments.length === 1)) {
    const ctx = jsonCtx(req, res, rawBody);
    handleRest(ctx, segments.slice(2));
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    // Every reply carries a non-empty X-GitHub-Request-Id.
    res.setHeader('x-github-request-id', nextRequestId());
    dispatch(req, res).catch((err: unknown) => {
      try {
        process.stderr.write(`[entry] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
        if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
        else res.end();
      } catch {
        // The socket is already gone; nothing left to do.
      }
    });
  });
}
