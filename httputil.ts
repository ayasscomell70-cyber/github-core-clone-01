// Shared HTTP plumbing for the JSON surfaces (REST v3, GraphQL v4, MCP): the request
// context, the bearer-token auth, JSON answers and Link pagination.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, type User } from './store.ts';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  /** The token owner, or null when the request carries no bearer token. */
  user: User | null;
  /** The parsed JSON body (undefined when there is no body or it is not JSON). */
  body: unknown;
  /** True when a body was present but did not parse as JSON. */
  bodyMalformed: boolean;
  query: URLSearchParams;
  /** The request's own origin, for absolute Link URLs. */
  origin: string;
}

/** The bearer token of a request, or null. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  // Fast path: the suite always sends "Bearer <token>" with one space.
  if (header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    return token === '' ? null : token;
  }
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  return match ? match[1]!.trim() : null;
}

/**
 * The token owner: any non-empty bearer token names the scenario's viewer (see
 * store.ts: the kit's scenario seed is constant, so the viewer is always adaiversen).
 */
export function authedUser(req: IncomingMessage): User | null {
  const token = bearerToken(req);
  return token !== null && token !== '' ? VIEWER : null;
}

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer with a JSON body. The request id header is set by app.ts up front. */
export function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Readonly<Record<string, string>> = {}): void {
  // One pass: encode the text and take its byte length from the same buffer
  // instead of scanning the string again with Buffer.byteLength.
  const data = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': data.length, ...extraHeaders });
  res.end(data);
}

/** Answer with a JSON error body: {"message": string}. */
export function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** A 204 with no body. */
export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204);
  res.end();
}

export interface PageParams {
  page: number;
  perPage: number;
}

export function pageParams(query: URLSearchParams): PageParams {
  const perPageRaw = parseInt(query.get('per_page') ?? '30', 10);
  const pageRaw = parseInt(query.get('page') ?? '1', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  return { page, perPage };
}

/**
 * Slice `items` to one page and build GitHub's Link header (rel="next"/"last" when
 * there are more pages, rel="prev"/"first" when past the first). `base` is the
 * request's path with its non-paging query preserved.
 */
export function paginate<T>(items: readonly T[], params: PageParams, base: string): { page: T[]; link: string | null } {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / params.perPage));
  const page = Math.min(params.page, totalPages);
  const start = (page - 1) * params.perPage;
  const slice = items.slice(start, start + params.perPage);
  const links: string[] = [];
  const urlFor = (p: number): string => {
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}page=${p}&per_page=${params.perPage}`;
  };
  if (page < totalPages) {
    links.push(`<${urlFor(page + 1)}>; rel="next"`);
    links.push(`<${urlFor(totalPages)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${urlFor(page - 1)}>; rel="prev"`);
    links.push(`<${urlFor(1)}>; rel="first"`);
  }
  return { page: slice, link: links.length > 0 ? links.join(', ') : null };
}

/** The path + query of a request, without the paging parameters, for Link building. */
export function linkBase(req: IncomingMessage, origin: string): string {
  const raw = req.url ?? '/';
  const url = new URL(raw, origin);
  url.searchParams.delete('page');
  url.searchParams.delete('per_page');
  return url.toString();
}
