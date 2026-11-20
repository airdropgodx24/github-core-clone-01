// Git object model for the forge: SHA-1 object ids, loose-object hashing, tree/commit/tag
// parsing and building, packfile reading (with OFS/REF delta resolution) and writing (plain
// objects), pkt-line framing, and reachability walks with optional shallow depth limits.
// Standard library only: node:crypto for SHA-1, node:zlib for pack compression.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** SHA-1 over "<type> <size>\0" + data, exactly as git names an object. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

// ------------------------------------------------------------------ trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('corrupt tree: no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('corrupt tree: truncated entry');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): Buffer {
  return Buffer.from(entry.mode === '40000' ? `${entry.name}/` : entry.name, 'utf8');
}

/** Build a tree object from entries, sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => Buffer.compare(treeSortKey(a), treeSortKey(b)));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data : data.subarray(0, blank);
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.toString('utf8').split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer?: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`, `committer ${fields.committer ?? fields.author}`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data : data.subarray(0, blank);
  const out: TagView = { object: '', type: '', tag: '' };
  for (const line of head.toString('utf8').split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
  }
  return out;
}

// ------------------------------------------------------------------ pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode a complete pkt-line stream; throws on malformed framing. */
export function decodePktLines(bytes: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line header');
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`invalid pkt-line length "${header}"`);
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length === 3 || length > 65520) {
      throw new Error(`invalid pkt-line length ${length}`);
    } else {
      if (offset + length > bytes.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

// ------------------------------------------------------------------ deltas

/** Apply a git delta stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint truncated');
      const byte = delta[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (delta[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

// ------------------------------------------------------------------ packfiles

function readPackHeader(buffer: Buffer, start: number): { size: number; typeCode: number; next: number } {
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, typeCode: (first >> 4) & 0x07, next: offset };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream starting at `offset`; reports where the stream ends. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/**
 * Read a packfile into resolved objects. Thin-pack REF_DELTA bases are taken from
 * `resolveBase` when given (the forge's own store is never thin, but pushes may be).
 */
export function readPack(
  pack: Buffer,
  resolveBase?: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  if (sha1Hex(pack.subarray(0, trailerStart)) !== trailer) throw new Error('pack checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset: number;
    baseOid: string;
    resolvedType: GitObjectType | null;
    resolvedData: Buffer | null;
    oid: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const header = readPackHeader(pack, offset);
    offset = header.next;
    const entry: Raw = {
      offset: entryOffset,
      typeCode: header.typeCode,
      data: Buffer.alloc(0),
      baseOffset: 0,
      baseOid: '',
      resolvedType: null,
      resolvedData: null,
      oid: '',
    };
    if (header.typeCode === 6) {
      const base = readOfsBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (header.typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (CODE_TYPE[header.typeCode] === undefined) {
      throw new Error(`unknown pack type code ${header.typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has trailing bytes');

  const byOid = new Map<string, Raw>();
  const resolving = new Set<number>();
  const resolve = (entry: Raw): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolvedData !== null && entry.resolvedType !== null) {
      return { type: entry.resolvedType, data: entry.resolvedData, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (baseEntry === undefined) throw new Error('ofs-delta base missing from pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const inPack = byOid.get(entry.baseOid);
      if (inPack !== undefined) {
        const base = resolve(inPack);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(entry.baseOid);
        if (external === undefined) throw new Error('ref-delta base missing');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolvedType = type;
    entry.resolvedData = data;
    entry.oid = oid;
    byOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  const objects = new Map<string, GitObject>();
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

function packObjectHeader(type: GitObjectType, size: number): Buffer {
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

/** Build a packfile from plain objects (no deltas), with a correct SHA-1 trailer. */
export function writePack(objects: Iterable<{ oid: string; type: GitObjectType; data: Buffer }>): Buffer {
  const list = [...objects];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const object of list) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ------------------------------------------------------------------ reachability

export type ObjectLookup = (oid: string) => GitObject | undefined;

/**
 * Every object reachable from `roots`. When `depth` is set, commits are followed at most
 * `depth` generations from a root commit (a root commit is generation 1); the trees and
 * blobs of every included commit are always included in full. `boundary` collects the
 * commits sitting exactly at the depth limit that still have parents (the shallow
 * boundary a fetch must report). Tag objects are peeled without consuming depth.
 */
export function collectReachable(
  roots: Iterable<string>,
  lookup: ObjectLookup,
  options: { depth?: number; boundary?: Set<string> } = {},
): Set<string> {
  const seen = new Set<string>();
  const depth = options.depth;
  // Work items: an object id plus the commit-generation it sits at (0 = not commit-limited).
  const queue: Array<{ oid: string; generation: number }> = [];
  for (const root of roots) if (isOid(root)) queue.push({ oid: root, generation: 1 });
  while (queue.length > 0) {
    const item = queue.pop() as { oid: string; generation: number };
    if (seen.has(item.oid)) continue;
    const object = lookup(item.oid);
    if (object === undefined) continue;
    seen.add(item.oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push({ oid: commit.tree, generation: 0 });
      const atLimit = depth !== undefined && item.generation >= depth;
      if (atLimit) {
        if (commit.parents.length > 0) options.boundary?.add(item.oid);
      } else {
        for (const parent of commit.parents) queue.push({ oid: parent, generation: item.generation + 1 });
      }
    } else if (object.type === 'tag') {
      queue.push({ oid: parseTag(object.data).object, generation: item.generation });
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push({ oid: entry.oid, generation: 0 });
      }
    }
  }
  return seen;
}

/** True when `ancestor` is `descendant` itself or one of its ancestors. */
export function isAncestor(lookup: ObjectLookup, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/** The nearest common ancestor of two commits, or null when their histories are disjoint. */
export function mergeBase(lookup: ObjectLookup, a: string, b: string): string | null {
  const ancestorsOf = (tip: string): Map<string, number> => {
    const distances = new Map<string, number>();
    const queue: Array<{ oid: string; distance: number }> = [{ oid: tip, distance: 0 }];
    while (queue.length > 0) {
      const item = queue.shift() as { oid: string; distance: number };
      if (distances.has(item.oid) && (distances.get(item.oid) as number) <= item.distance) continue;
      distances.set(item.oid, item.distance);
      const object = lookup(item.oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        queue.push({ oid: parent, distance: item.distance + 1 });
      }
    }
    return distances;
  };
  const fromA = ancestorsOf(a);
  const fromB = ancestorsOf(b);
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [oid, distanceA] of fromA) {
    const distanceB = fromB.get(oid);
    if (distanceB === undefined) continue;
    const score = distanceA + distanceB;
    if (score < bestScore) {
      bestScore = score;
      best = oid;
    }
  }
  return best;
}
