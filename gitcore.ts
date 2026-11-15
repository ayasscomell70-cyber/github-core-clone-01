// Git's object model from scratch: SHA-1 ids, pkt-lines, packfiles (read with delta
// resolution, write without deltas), reachability, shallow boundaries, tree building
// and three-way merges. Only Node's stdlib (crypto, zlib). Every byte the forge stores
// or sends is the client's own bytes, never re-serialised: pushed commits, trees, blobs
// and tags round-trip byte-exactly.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import type { GitObject, ObjectType, Repo } from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && OID_RE.test(value);
}

/** The SHA-1 of `<type> <size>\0<data>`. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

// -------------------------------------------------------------------------------------------
// pkt-lines
// -------------------------------------------------------------------------------------------

export type PktLine = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

/** One pkt-line: 4 hex length digits (the length counts itself) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 65520) throw new Error(`pkt-line of ${length} bytes exceeds the 65520 limit`);
  const head = Buffer.alloc(4);
  head.write(length.toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Encode lines ('flush' / 'delim' for the control packets). */
export function encodePktLines(lines: ReadonlyArray<string | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

/** Incremental pkt-line decoder over arbitrary chunk boundaries. */
export class PktLineDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
  }

  next(): PktLine | null {
    if (this.buffer.length < 4) return null;
    const head = this.buffer.subarray(0, 4).toString('ascii');
    if (head === '0000') {
      this.buffer = this.buffer.subarray(4);
      return { kind: 'flush' };
    }
    if (head === '0001') {
      this.buffer = this.buffer.subarray(4);
      return { kind: 'delim' };
    }
    const length = parseInt(head, 16);
    if (!Number.isFinite(length) || length < 4 || length > 65520) {
      throw new Error(`malformed pkt-line length ${JSON.stringify(head)}`);
    }
    if (this.buffer.length < length) return null;
    const payload = Buffer.from(this.buffer.subarray(4, length));
    this.buffer = this.buffer.subarray(length);
    return { kind: 'data', payload };
  }

  /** True when the stream ended cleanly on a packet boundary. */
  finish(): boolean {
    return this.buffer.length === 0;
  }

  /** Bytes left unparsed (a pack follows the flush in receive-pack). */
  rest(): Buffer {
    return this.buffer;
  }
}

/** Decode a whole buffer of pkt-lines (no trailing bytes allowed). */
export function decodePktLines(buffer: Buffer): PktLine[] {
  const decoder = new PktLineDecoder();
  decoder.push(buffer);
  const out: PktLine[] = [];
  for (let packet = decoder.next(); packet !== null; packet = decoder.next()) out.push(packet);
  if (!decoder.finish()) throw new Error('trailing bytes after the last pkt-line');
  return out;
}

// -------------------------------------------------------------------------------------------
// packfiles
// -------------------------------------------------------------------------------------------

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). Order is the caller's; duplicates removed. */
export function writePack(objects: ReadonlyArray<GitObject>): Buffer {
  const seen = new Set<string>();
  const list: GitObject[] = [];
  for (const object of objects) {
    const oid = hashObject(object.type, object.data);
    if (seen.has(oid)) continue;
    seen.add(oid);
    list.push(object);
  }
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** The trailer SHA-1 of a pack's bytes (everything before the last 20 bytes). */
export function packChecksum(pack: Buffer): string {
  return createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
  resolvedType?: ObjectType;
  resolved?: Buffer;
  oid?: string;
}

function readVarintSize(buffer: Buffer, offset: number): { size: number; first: number; next: number } {
  const first = buffer[offset] ?? 0;
  let size = first & 0x0f;
  let shift = 4;
  let pos = offset + 1;
  let byte = first;
  while ((byte & 0x80) !== 0) {
    byte = buffer[pos] ?? 0;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return { size, first, next: pos };
}

function readOfsDeltaBase(buffer: Buffer, offset: number): { baseOffset: number; next: number } {
  let byte = buffer[offset] ?? 0;
  let baseOffset = byte & 0x7f;
  let pos = offset + 1;
  while ((byte & 0x80) !== 0) {
    byte = buffer[pos] ?? 0;
    baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
    pos += 1;
  }
  return { baseOffset, next: pos };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  // inflateSync needs the exact slice; find the end by growing the window.
  // zlib's inflateSync on a truncated stream throws, so binary-search the end.
  let low = offset;
  let high = buffer.length;
  let found = -1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    try {
      inflateSync(buffer.subarray(offset, mid));
      found = mid;
      high = mid - 1;
    } catch {
      low = mid + 1;
    }
  }
  if (found < 0) throw new Error('pack entry does not inflate');
  return { data: inflateSync(buffer.subarray(offset, found)), next: found };
}

/** Apply a git delta (source-size varint, target-size varint, copy/insert ops). */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos] ?? 0;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta source size ${sourceSize} does not match base ${base.length}`);
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos] ?? 0;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if ((op & 0x01) !== 0) {
        offset = delta[pos] ?? 0;
        pos += 1;
      }
      if ((op & 0x02) !== 0) {
        offset |= (delta[pos] ?? 0) << 8;
        pos += 1;
      }
      if ((op & 0x04) !== 0) {
        offset |= (delta[pos] ?? 0) << 16;
        pos += 1;
      }
      if ((op & 0x08) !== 0) {
        offset |= (delta[pos] ?? 0) << 24;
        pos += 1;
      }
      if ((op & 0x10) !== 0) {
        size = delta[pos] ?? 0;
        pos += 1;
      }
      if ((op & 0x20) !== 0) {
        size |= (delta[pos] ?? 0) << 8;
        pos += 1;
      }
      if ((op & 0x40) !== 0) {
        size |= (delta[pos] ?? 0) << 16;
        pos += 1;
      }
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy runs past the base');
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) {
    throw new Error(`delta produced ${produced} bytes, expected ${targetSize}`);
  }
  return result;
}

/**
 * Read a packfile: verify the trailer, resolve OFS_DELTA and REF_DELTA entries (a REF_DELTA
 * base may live in the pack or be supplied through `resolveBase`), and return every object
 * keyed by its recomputed id.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  if (trailer !== packChecksum(pack)) throw new Error('pack trailer does not match its bytes');

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: ObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: ObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, deltaCount };
}

// -------------------------------------------------------------------------------------------
// commit / tree / tag objects
// -------------------------------------------------------------------------------------------

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit's headers and message (byte-exact round-trip: the raw bytes are stored). */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  // Git cleans a message's trailing blank lines; the object keeps them, but
  // every view (REST, GraphQL) shows the message without them.
  const message = split < 0 ? '' : text.slice(split + 2).replace(/\n+$/, '');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(input: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${input.author} ${input.timestamp} +0000`);
  lines.push(`committer ${input.committer} ${input.timestamp} +0000`);
  lines.push('');
  lines.push(input.message.endsWith('\n') ? input.message : `${input.message}\n`);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) throw new Error('tree entry has no mode');
    const mode = data.subarray(pos, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name');
    const name = data.subarray(space + 1, nul).toString('utf8');
    if (nul + 21 > data.length) throw new Error('tree entry oid is truncated');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    // Git sorts by name, directories as if their name ended in '/'.
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2).replace(/\n+$/, '');
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(input: {
  object: string;
  type: string;
  tag: string;
  message: string;
  tagger: string;
  timestamp: number;
}): Buffer {
  const lines = [
    `object ${input.object}`,
    `type ${input.type}`,
    `tag ${input.tag}`,
    `tagger ${input.tagger} ${input.timestamp} +0000`,
    '',
    input.message.endsWith('\n') ? input.message : `${input.message}\n`,
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

// -------------------------------------------------------------------------------------------
// reachability
// -------------------------------------------------------------------------------------------

export type ObjectLookup = (oid: string) => GitObject | undefined;

/** Every object reachable from `tips` (commits, their trees and blobs, peeled tags). */
export function collectReachable(lookup: ObjectLookup, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const parsed = parseCommit(object.data);
      stack.push(parsed.tree);
      for (const parent of parsed.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** The commits reachable from `tips`, following parents (no depth limit). */
export function commitClosure(lookup: ObjectLookup, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return seen;
}

/** True when `ancestor` is `tip` itself or reachable from it through parents. */
export function isAncestor(lookup: ObjectLookup, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const stack = [tip];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      stack.push(parent);
    }
  }
  return false;
}

/** The first common ancestor of `a` and `b` (BFS from both tips, newest first). */
export function mergeBase(lookup: ObjectLookup, a: string, b: string): string | null {
  if (a === b) return a;
  const fromA = new Map<string, number>();
  const queueA: Array<[string, number]> = [[a, 0]];
  while (queueA.length > 0) {
    const [oid, dist] = queueA.shift()!;
    if (fromA.has(oid)) continue;
    fromA.set(oid, dist);
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push([parent, dist + 1]);
  }
  const queueB: Array<[string, number]> = [[b, 0]];
  const seenB = new Set<string>();
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  while (queueB.length > 0) {
    const [oid, dist] = queueB.shift()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const distA = fromA.get(oid);
    if (distA !== undefined && distA + dist < bestScore) {
      best = oid;
      bestScore = distA + dist;
    }
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push([parent, dist + 1]);
  }
  return best;
}

// -------------------------------------------------------------------------------------------
// fetch planning (what a fetch sends, and which shallow boundaries it reports)
// -------------------------------------------------------------------------------------------

export interface FetchPlan {
  /** The objects to send (commits, trees, blobs, tags), each once. */
  objects: GitObject[];
  /** New shallow boundaries (commits whose parents are not sent and not held). */
  shallow: string[];
  /** Old boundaries whose parents are now included. */
  unshallow: string[];
}

/**
 * Plan a fetch. `wants` are the tips, `haves` the commits the client holds, `shallow`
 * the client's current shallow boundaries, `depth` the deepen limit (commits within
 * distance < depth of a want). A have-closure never crosses a shallow boundary: the
 * client holds the boundary commit, not its parents.
 */
export function planFetch(
  lookup: ObjectLookup,
  wants: readonly string[],
  haves: readonly string[],
  shallow: readonly string[],
  depth?: number,
): FetchPlan {
  const shallowSet = new Set(shallow);
  // The commits the client holds: from haves, stopping at shallow boundaries.
  const haveCommits = new Set<string>();
  {
    const stack = [...haves];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (haveCommits.has(oid)) continue;
      const object = lookup(oid);
      if (!object || object.type !== 'commit') continue;
      haveCommits.add(oid);
      if (shallowSet.has(oid)) continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
  }
  // The commits the fetch covers: from wants, within the depth limit.
  const wantCommits = new Set<string>();
  const tagObjects: string[] = [];
  {
    const queue: Array<[string, number]> = wants.map((oid) => [oid, 0] as [string, number]);
    const seen = new Set<string>();
    while (queue.length > 0) {
      const [oid, dist] = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = lookup(oid);
      if (!object) continue;
      if (object.type === 'tag') {
        tagObjects.push(oid);
        const target = parseTag(object.data).object;
        if (!seen.has(target)) queue.push([target, dist]);
        continue;
      }
      if (object.type !== 'commit') continue;
      if (depth !== undefined && dist >= depth) continue;
      wantCommits.add(oid);
      for (const parent of parseCommit(object.data).parents) queue.push([parent, dist + 1]);
    }
  }
  const sendCommits = new Set<string>();
  for (const oid of wantCommits) if (!haveCommits.has(oid)) sendCommits.add(oid);

  // The tree/blob closure of a commit set (never walking parents).
  const closureOf = (commits: ReadonlySet<string>): Set<string> => {
    const out = new Set<string>();
    const stack: string[] = [];
    for (const oid of commits) {
      out.add(oid);
      const object = lookup(oid);
      if (object?.type === 'commit') stack.push(parseCommit(object.data).tree);
    }
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (out.has(oid)) continue;
      const object = lookup(oid);
      if (!object) continue;
      out.add(oid);
      if (object.type === 'tree') for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
    return out;
  };
  const wantObjects = closureOf(wantCommits);
  const haveObjects = closureOf(haveCommits);
  const send = new Set<string>();
  for (const oid of wantObjects) if (!haveObjects.has(oid)) send.add(oid);
  for (const oid of tagObjects) if (!haveObjects.has(oid)) send.add(oid);

  const objects: GitObject[] = [];
  for (const oid of send) {
    const object = lookup(oid);
    if (object) objects.push(object);
  }

  // Shallow boundaries: sent commits with a parent neither sent nor held.
  const shallowOut: string[] = [];
  for (const oid of sendCommits) {
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0) continue;
    const excluded = parents.some((parent) => !sendCommits.has(parent) && !haveCommits.has(parent));
    if (excluded) shallowOut.push(oid);
  }
  // Old boundaries that stay shallow (their parents are still excluded).
  for (const boundary of shallowSet) {
    if (sendCommits.has(boundary) || haveCommits.has(boundary) === false) {
      // A boundary the client still holds but whose parents are still missing stays shallow,
      // unless it was re-sent (then it is covered by shallowOut) or its parents arrived.
      if (shallowOut.includes(boundary)) continue;
      const object = lookup(boundary);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length === 0) continue;
      const stillExcluded = parents.some((parent) => !sendCommits.has(parent) && !haveCommits.has(parent));
      if (stillExcluded && !haveCommits.has(boundary)) continue;
      if (stillExcluded && !sendCommits.has(boundary)) shallowOut.push(boundary);
    }
  }
  // Unshallow: old boundaries whose parents are now all included.
  const unshallow: string[] = [];
  for (const boundary of shallowSet) {
    if (shallowOut.includes(boundary)) continue;
    const object = lookup(boundary);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.length === 0) continue;
    const included = parents.every((parent) => sendCommits.has(parent) || haveCommits.has(parent));
    if (included) unshallow.push(boundary);
  }
  shallowOut.sort();
  unshallow.sort();
  return { objects, shallow: shallowOut, unshallow };
}

// -------------------------------------------------------------------------------------------
// trees as file maps (contents API, merges, pull-request files)
// -------------------------------------------------------------------------------------------

/** A repo's tree flattened to path -> {oid, mode} (files only). */
export function flattenTree(lookup: ObjectLookup, rootTreeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (treeOid: string, prefix: string): void => {
    const object = lookup(treeOid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(rootTreeOid, '');
  return out;
}

export interface BuiltTree {
  rootOid: string;
  /** The new tree objects created (oid -> object), to store. */
  trees: Map<string, GitObject>;
}

/** Build nested trees from a flat path -> blob map. */
export function buildTreeFromFiles(files: ReadonlyMap<string, { oid: string; mode: string }>): BuiltTree {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, file] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, file);
  }
  const trees = new Map<string, GitObject>();
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    trees.set(oid, { type: 'tree', data });
    return oid;
  };
  return { rootOid: build(root), trees };
}

/** The tree object at a path inside a root tree (a file or a subtree), or null. */
export function treeEntryAtPath(
  lookup: ObjectLookup,
  rootTreeOid: string,
  path: string,
): { oid: string; mode: string } | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let current = rootTreeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = lookup(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (!entry) return null;
    if (index === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

export interface ThreeWayMerge {
  /** The merged file map (path -> blob). */
  files: Map<string, { oid: string; mode: string }>;
  /** Paths both sides changed differently. */
  conflicts: string[];
}

/** Three-way merge of file maps: base, ours, theirs. */
export function threeWayMerge(
  base: ReadonlyMap<string, { oid: string; mode: string }>,
  ours: ReadonlyMap<string, { oid: string; mode: string }>,
  theirs: ReadonlyMap<string, { oid: string; mode: string }>,
): ThreeWayMerge {
  const files = new Map<string, { oid: string; mode: string }>();
  const conflicts: string[] = [];
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    const same = (a?: { oid: string }, c?: { oid: string }): boolean =>
      (a === undefined && c === undefined) || (a !== undefined && c !== undefined && a.oid === c.oid);
    if (same(o, t)) {
      if (o) files.set(path, o);
    } else if (same(o, b)) {
      if (t) files.set(path, t);
    } else if (same(t, b)) {
      if (o) files.set(path, o);
    } else {
      conflicts.push(path);
      // Keep ours for the map (the merge is refused anyway when conflicts exist).
      if (o) files.set(path, o);
    }
  }
  conflicts.sort();
  return { files, conflicts };
}

/** The files a pull request changes: base tree -> head tree, with line counts. */
export function diffFiles(
  lookup: ObjectLookup,
  baseTreeOid: string,
  headTreeOid: string,
): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
  const baseFiles = flattenTree(lookup, baseTreeOid);
  const headFiles = flattenTree(lookup, headTreeOid);
  const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
  const lineCount = (oid: string): number => {
    const object = lookup(oid);
    if (!object || object.type !== 'blob') return 0;
    const text = object.data.toString('utf8');
    if (text === '') return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  };
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  for (const path of [...paths].sort()) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    if (b && h && b.oid === h.oid) continue;
    if (!b && h) {
      const additions = lineCount(h.oid);
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && !h) {
      const deletions = lineCount(b.oid);
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b && h) {
      const additions = lineCount(h.oid);
      const deletions = lineCount(b.oid);
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** Look up an object in a repo (or undefined). */
export function repoLookup(repo: Repo): ObjectLookup {
  return (oid: string) => repo.objects.get(oid);
}
