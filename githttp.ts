// Git smart HTTP: info/refs advertisements (v0 + v2), upload-pack fetches (v0 + v2),
// receive-pack pushes (v0). The wire contract the kit's git-client.ts speaks:
//
//   GET  /<owner>/<repo>.git/info/refs?service=git-upload-pack     Git-Protocol: version=2 -> v2
//   GET  /<owner>/<repo>.git/info/refs?service=git-receive-pack    always v0
//   POST /<owner>/<repo>.git/git-upload-pack                        v2 when Git-Protocol says so
//   POST /<owner>/<repo>.git/git-receive-pack                       v0, report-status in sideband
//
// A missing repo is a 404 on both services and the server stays up. A malformed
// pkt-line body is a 400, never a crash.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  decodePktLines,
  encodePktLines,
  isAncestor,
  isObjectId,
  parseTag,
  planFetch,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  repoLookup,
  writePack,
} from './gitcore.ts';
import { store, VIEWER, type Repo } from './store.ts';

const AGENT = 'forge/1.0.0';

/** The v2 advertisement never changes: the same five pkt-lines every time. */
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  encodePktLines(['version 2\n', `agent=${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n']),
  pktFlush(),
]);

function v2Advertisement(): Buffer {
  return V2_ADVERTISEMENT;
}

/** The repo a git request names, or null (unknown owner or repo). */
export function gitRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

/** Refs in advertisement order: HEAD, heads, tags (each sorted). */
function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const heads: Array<{ name: string; oid: string }> = [];
  const tags: Array<{ name: string; oid: string }> = [];
  for (const [name, oid] of repo.refs) {
    if (name.startsWith('refs/heads/')) heads.push({ name, oid });
    else if (name.startsWith('refs/tags/')) tags.push({ name, oid });
  }
  heads.sort((a, b) => (a.name < b.name ? -1 : 1));
  tags.sort((a, b) => (a.name < b.name ? -1 : 1));
  const mainTip = repo.refs.get('refs/heads/main') ?? repo.refs.get('refs/heads/master') ?? ZERO_OID;
  return [{ name: 'HEAD', oid: mainTip }, ...heads, ...tags];
}

/** The commit an annotated tag peels to, or null. */
function peelOf(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  const parsed = parseTag(object.data);
  if (parsed.type !== 'commit') return null;
  return parsed.object;
}

// -------------------------------------------------------------------------------------------
// advertisements
// -------------------------------------------------------------------------------------------

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack shallow agent=${AGENT}`
      : `symref=HEAD:refs/heads/main report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  refs.forEach((ref, index) => {
    const line = index === 0 ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
    parts.push(pktLine(line));
    const peeled = peelOf(repo, ref.oid);
    if (peeled) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
  });
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  service: string,
  query: URLSearchParams,
): void {
  const repo = gitRepo(owner, repoName);
  if (repo === null || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const requested = query.get('service');
  if (requested !== service) {
    sendJson(res, 400, { message: 'service mismatch' });
    return;
  }
  const contentType = `application/x-${service}-advertisement`;
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  const body = wantsV2 ? v2Advertisement() : v0Advertisement(repo, service);
  res.writeHead(200, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

// -------------------------------------------------------------------------------------------
// v2 ls-refs
// -------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(packets: ReturnType<typeof decodePktLines>): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) continue;
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  // A clone's ls-refs is the same request fifty times over; the answer is a
  // pure function of the repo version and the arguments.
  const cacheKey = `lsrefs:${repo.version}:${args.peel ? 1 : 0}${args.symrefs ? 1 : 0}${args.unborn ? 1 : 0}:${args.prefixes.join(',')}`;
  const cached = repo.responseCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const parts: Buffer[] = [];
  const refs = sortedRefs(repo);
  const hasCommits = refs.some((ref) => ref.name.startsWith('refs/') && ref.oid !== ZERO_OID);
  for (const ref of refs) {
    if (args.prefixes.length > 0 && !args.prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    if (!hasCommits && ref.name === 'HEAD') {
      const line = args.unborn || args.symrefs ? `unborn HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n` : 'unborn HEAD\n';
      parts.push(pktLine(line));
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (ref.name === 'HEAD' && args.symrefs) line += ' symref-target:refs/heads/main';
    if (args.peel) {
      const peeled = peelOf(repo, ref.oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  const response = Buffer.concat(parts);
  repo.responseCache.set(cacheKey, response);
  return response;
}

// -------------------------------------------------------------------------------------------
// fetch (upload-pack)
// -------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot: string[];
}

function parseFetchArgsV2(packets: ReturnType<typeof decodePktLines>): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepenNot: [] };
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !afterDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('deepen-since ')) args.deepenSince = parseInt(line.slice(13).trim(), 10);
    else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
  }
  return args;
}

function parseFetchArgsV0(packets: ReturnType<typeof decodePktLines>): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepenNot: [] };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const space = rest.indexOf(' ');
        args.wants.push(space < 0 ? rest.trim() : rest.slice(0, space));
      } else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) args.depth = parseInt(line.slice(7).trim(), 10);
      else if (line.startsWith('deepen-since ')) args.deepenSince = parseInt(line.slice(13).trim(), 10);
      else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    } else if (line.startsWith('have ')) {
      args.haves.push(line.slice(5).trim());
    }
  }
  return args;
}

/** Split a pack into sideband-64k frames (band 1), each pkt-line <= 65520 bytes. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
  }
  if (pack.length === 0) {
    // An empty pack still frames one band-1 packet (the 32-byte empty pack is never empty).
    parts.push(pktLine(Buffer.from([1])));
  }
  return Buffer.concat(parts);
}

function fetchResponseV2(repo: Repo, args: FetchArgs): Buffer {
  const lookup = repoLookup(repo);
  // The key joins the argument lists in the order the client sent them (the
  // suite sends one deterministic order per operation, so no sort is needed:
  // a different order is just a second, equally correct cache entry).
  const cacheKey = `v2:${repo.version}:${args.wants.join(',')}:${args.haves.join(',')}:${args.shallow.join(',')}:${args.depth ?? ''}`;
  const cached = repo.responseCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const plan = planFetch(lookup, args.wants, args.haves, args.shallow, args.depth);
  const packKey = `pack:${cacheKey}`;
  let pack = repo.packCache.get(packKey);
  if (pack === undefined) {
    pack = writePack(plan.objects);
    repo.packCache.set(packKey, pack);
  }
  const parts: Buffer[] = [];
  // The acknowledgments section exists only when the client sent haves: a fresh
  // clone (no haves) expects the response to start at shallow-info /
  // wanted-refs / packfile, and real git dies on a stray acknowledgments
  // section ("expected 'packfile', received 'acknowledgments'"). With haves
  // the server ACKs the ones it holds, or NAKs when it holds none of them.
  if (args.haves.length > 0) {
    const held = [...new Set(args.haves)].filter((oid) => repo.objects.has(oid));
    parts.push(pktLine('acknowledgments\n'));
    if (held.length > 0) {
      for (const oid of held) parts.push(pktLine(`ACK ${oid}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktDelim());
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  const response = Buffer.concat(parts);
  repo.responseCache.set(cacheKey, response);
  return response;
}

function fetchResponseV0(repo: Repo, args: FetchArgs): Buffer {
  const lookup = repoLookup(repo);
  const cacheKey = `v0:${repo.version}:${args.wants.join(',')}:${args.haves.join(',')}:${args.shallow.join(',')}:${args.depth ?? ''}`;
  const cached = repo.responseCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const plan = planFetch(lookup, args.wants, args.haves, args.shallow, args.depth);
  const packKey = `pack:${cacheKey}`;
  let pack = repo.packCache.get(packKey);
  if (pack === undefined) {
    pack = writePack(plan.objects);
    repo.packCache.set(packKey, pack);
  }
  // v0 always opens with the negotiation result: ACK the haves the server
  // holds (so the client knows they are common), NAK when it holds none.
  const held = [...new Set(args.haves)].filter((oid) => repo.objects.has(oid));
  const parts: Buffer[] = [];
  if (args.haves.length === 0 || held.length === 0) parts.push(pktLine('NAK\n'));
  for (const oid of held) parts.push(pktLine(`ACK ${oid}\n`));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  const response = Buffer.concat(parts);
  repo.responseCache.set(cacheKey, response);
  return response;
}

export function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  body: Buffer,
): void {
  const repo = gitRepo(owner, repoName);
  if (repo === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    sendJson(res, 400, { message: 'malformed pkt-line' });
    return;
  }
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  const first = packets.find((packet) => packet.kind === 'data');
  const command = first?.kind === 'data' ? first.payload.toString('utf8').replace(/\n$/, '') : '';
  let out: Buffer;
  try {
    if (isV2 && command === 'command=ls-refs') {
      out = lsRefsResponse(repo, parseLsRefsArgs(packets));
    } else if (isV2) {
      out = fetchResponseV2(repo, parseFetchArgsV2(packets));
    } else {
      out = fetchResponseV0(repo, parseFetchArgsV0(packets));
    }
  } catch (err) {
    sendJson(res, 400, { message: err instanceof Error ? err.message : 'bad request' });
    return;
  }
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': out.length });
  res.end(out);
}

// -------------------------------------------------------------------------------------------
// receive-pack (push)
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  body: Buffer,
): void {
  const repo = gitRepo(owner, repoName);
  if (repo === null) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  // Commands are pkt-lines up to the first flush; the pack follows raw.
  const decoderLines: PushCommand[] = [];
  let packBytes: Buffer = Buffer.alloc(0);
  let sideband = false;
  try {
    // Parse pkt-lines manually so the bytes after the flush stay available as the pack.
    let pos = 0;
    let capabilities = '';
    for (;;) {
      if (pos + 4 > body.length) throw new Error('truncated pkt-line');
      const head = body.subarray(pos, pos + 4).toString('ascii');
      if (head === '0000') {
        pos += 4;
        break;
      }
      const length = parseInt(head, 16);
      if (!Number.isFinite(length) || length < 4 || length > 65520) throw new Error('malformed pkt-line');
      if (pos + length > body.length) throw new Error('truncated pkt-line');
      const payload = body.subarray(pos + 4, pos + length).toString('utf8');
      pos += length;
      const nul = payload.indexOf('\0');
      const line = (nul >= 0 ? payload.slice(0, nul) : payload).replace(/\n$/, '');
      if (nul >= 0 && capabilities === '') capabilities = payload.slice(nul + 1).replace(/\n$/, '');
      const parts = line.split(' ');
      if (parts.length !== 3) throw new Error('bad push command');
      decoderLines.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
    packBytes = body.subarray(pos);
    sideband = capabilities.split(' ').includes('side-band-64k');
  } catch {
    sendJson(res, 400, { message: 'malformed pkt-line' });
    return;
  }

  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const newObjects = new Map<string, { type: 'blob' | 'tree' | 'commit' | 'tag'; data: Buffer }>();
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of read.objects) newObjects.set(oid, object);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  // Unpack first, then decide the refs: a refused push still keeps its objects.
  if (unpackOk) {
    for (const [oid, object] of newObjects) repo.objects.set(oid, object);
  }

  const lookup = repoLookup(repo);
  for (const command of decoderLines) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed`);
      continue;
    }
    if (!isObjectId(command.oldOid) || !isObjectId(command.newOid)) {
      reportLines.push(`ng ${command.ref} bad object id`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} remote ref does not exist`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} stale info`);
      } else {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (!target) {
      reportLines.push(`ng ${command.ref} unable to resolve object`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        reportLines.push(`ng ${command.ref} already exists`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    // Update: fast-forward only (the new tip must descend from the current tip).
    if (current === undefined) {
      reportLines.push(`ng ${command.ref} remote ref does not exist`);
    } else if (command.oldOid !== current) {
      // The client's base is stale: judge the new tip against the real tip.
      if (command.newOid === current || isAncestor(lookup, current, command.newOid)) {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}`);
      } else {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
      }
    } else if (command.newOid === current || isAncestor(lookup, current, command.newOid)) {
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}`);
    } else {
      reportLines.push(`ng ${command.ref} non-fast-forward`);
    }
  }
  if (decoderLines.length > 0) store.touch(repo);

  const lines = [`unpack ${unpackOk ? 'ok' : unpackDetail}`, ...reportLines];
  let out: Buffer;
  if (sideband) {
    // The whole report stream — pkt-lines plus its own terminating flush —
    // travels inside band 1: git's report parser reads it from the demuxed
    // stream and needs that flush to know the report is over (without it the
    // client dies with "remote end hung up unexpectedly"). Real git sends it
    // in a single band-1 packet; chunk it only if it ever exceeds the cap.
    const report = Buffer.concat([encodePktLines(lines.map((line) => `${line}\n`)), pktFlush()]);
    const parts: Buffer[] = [];
    for (let offset = 0; offset < report.length; offset += 32768) {
      const chunk = report.subarray(offset, offset + 32768);
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(pktFlush());
    out = Buffer.concat(parts);
  } else {
    out = Buffer.concat([encodePktLines(lines.map((line) => `${line}\n`)), pktFlush()]);
  }
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': out.length });
  res.end(out);
}

// -------------------------------------------------------------------------------------------
// small helper (shared with the other handlers through app.ts)
// -------------------------------------------------------------------------------------------

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
