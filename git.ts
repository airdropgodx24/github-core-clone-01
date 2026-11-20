// Git smart HTTP: the /{owner}/{repo}.git surface.
//
// upload-pack speaks protocol v2 when the client asks (Git-Protocol: version=2):
// a "version 2" capability advertisement, ls-refs and fetch (with shallow/deepen).
// Without the header it falls back to the v0 advertisement and the v0 fetch framing.
// receive-pack is v0 only, advertising report-status, side-band-64k and delete-refs,
// and applies ref updates one by one: a non-fast-forward update is refused per ref
// ("ng <ref> non-fast-forward") while a fast-forward ref in the same push still moves.

import {
  collectReachable,
  decodePktLines,
  isAncestor,
  isOid,
  parseTag,
  pktLine,
  readPack,
  writePack,
  ZERO_OID,
  PKT_DELIM,
  PKT_FLUSH,
  type GitObject,
} from './gitobj.ts';
import { store, type RepoRec } from './store.ts';

export type GitService = 'git-upload-pack' | 'git-receive-pack';

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'forge/1.0';

function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Peel a ref target through tag objects to the commit it ultimately names. */
function peelToCommit(oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 8; depth += 1) {
    const object = store.getObject(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// ------------------------------------------------------------------ advertisements

function v0Advertisement(repo: RepoRec, service: GitService): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack thin-pack side-band-64k ofs-delta shallow agent=${AGENT} symref=HEAD:${headTarget(repo)}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:${headTarget(repo)}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    const headOid = repo.refs.get(headTarget(repo)) ?? ZERO_OID;
    let first = true;
    const lines: Array<[string, string]> = [['HEAD', headOid], ...refs];
    for (const [name, oid] of lines) {
      parts.push(pktLine(first ? `${oid} ${name}\0${caps}` : `${oid} ${name}`));
      first = false;
      const object = store.getObject(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(oid);
        if (peeled !== null) parts.push(pktLine(`${peeled} ${name}^{}`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

export function infoRefs(repo: RepoRec, service: GitService, wantsV2: boolean): GitReply {
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && wantsV2) {
    return { status: 200, contentType, body: v2Advertisement() };
  }
  return { status: 200, contentType, body: v0Advertisement(repo, service) };
}

// ------------------------------------------------------------------ ls-refs (v2)

function lsRefs(repo: RepoRec, packets: Array<{ kind: string; payload?: Buffer }>): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data' || packet.payload === undefined) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) continue;
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const object = store.getObject(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = peelToCommit(oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ fetch (v2 + v0)

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  done: boolean;
}

function computeFetch(repo: RepoRec, args: FetchArgs): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  void repo;
  const shallowSet = new Set(args.shallow);
  const haveSet = new Set<string>();
  for (const have of args.haves) {
    if (!isOid(have) || store.getObject(have) === undefined) continue;
    const closure = shallowSet.has(have)
      ? collectReachable([have], store.lookup, { depth: 1 })
      : collectReachable([have], store.lookup);
    for (const oid of closure) haveSet.add(oid);
  }
  const boundary = new Set<string>();
  const wantSet = collectReachable(
    args.wants.filter((oid) => isOid(oid) && store.getObject(oid) !== undefined),
    store.lookup,
    args.deepen !== null ? { depth: args.deepen, boundary } : {},
  );
  const send: Array<{ oid: string; type: GitObject['type']; data: Buffer }> = [];
  for (const oid of wantSet) {
    if (haveSet.has(oid)) continue;
    const object = store.getObject(oid);
    if (object !== undefined) send.push({ oid, type: object.type, data: object.data });
  }
  send.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const pack = writePack(send);
  const shallow = [...boundary].filter((oid) => !haveSet.has(oid)).sort();
  const unshallow = args.shallow
    .filter((oid) => wantSet.has(oid) && !boundary.has(oid) && store.getObject(oid) !== undefined)
    .sort();
  return { pack, shallow, unshallow };
}

/** Split a pack into side-band-64k band-1 pkt-lines (length field caps at 65520). */
function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 65512;
  if (pack.length === 0) return parts;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

function fetchV2(repo: RepoRec, packets: Array<{ kind: string; payload?: Buffer }>): Buffer {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, done: false };
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data' || packet.payload === undefined) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!inArgs) continue;
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number.parseInt(line.slice(7).trim(), 10) || null;
    else if (line === 'done') args.done = true;
  }
  const result = computeFetch(repo, args);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  const common = args.haves.find((have) => store.getObject(have) !== undefined);
  if (!args.done) {
    parts.push(pktLine(common !== undefined ? `ACK ${common}\n` : 'NAK\n'));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine(common !== undefined ? `ACK ${common}\n` : 'NAK\n'));
  }
  parts.push(PKT_DELIM);
  if (result.shallow.length > 0 || result.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of result.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of result.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  if (args.done) {
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(result.pack));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0(repo: RepoRec, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, done: false };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) args.wants.push(line.slice(5, 45));
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) args.deepen = Number.parseInt(line.slice(7).trim(), 10) || null;
    } else {
      if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line === 'done') args.done = true;
    }
  }
  const result = computeFetch(repo, args);
  const parts: Buffer[] = [];
  for (const oid of result.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of result.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const common = args.haves.find((have) => store.getObject(have) !== undefined);
  parts.push(pktLine(common !== undefined ? `ACK ${common}\n` : 'NAK\n'));
  parts.push(...sidebandPackets(result.pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function uploadPack(repo: RepoRec, body: Buffer, isV2: boolean): GitReply {
  const contentType = 'application/x-git-upload-pack-result';
  if (!isV2) return { status: 200, contentType, body: fetchV0(repo, body) };
  const packets = decodePktLines(body);
  let command = '';
  for (const packet of packets) {
    if (packet.kind !== 'data') break;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('command=')) {
      command = line.slice('command='.length);
      break;
    }
  }
  if (command === 'ls-refs') return { status: 200, contentType, body: lsRefs(repo, packets) };
  if (command === 'fetch') return { status: 200, contentType, body: fetchV2(repo, packets) };
  throw new Error(`unknown protocol v2 command ${JSON.stringify(command)}`);
}

// ------------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(repo: RepoRec, body: Buffer): GitReply {
  const contentType = 'application/x-git-receive-pack-result';
  // Split the command list (pkt-lines up to the first flush) from the pack that follows.
  const commands: PushCommand[] = [];
  let capabilities = '';
  let offset = 0;
  let packStart = -1;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packStart = offset + 4;
      break;
    }
    if (length < 4 || offset + length > body.length) break;
    let line = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const fields = line.split(' ');
    if (fields.length === 3 && isOid(fields[0] as string) && isOid(fields[1] as string)) {
      commands.push({ oldOid: fields[0] as string, newOid: fields[1] as string, ref: fields[2] as string });
    }
    offset += length;
  }
  const pack = packStart >= 0 && packStart < body.length ? body.subarray(packStart) : Buffer.alloc(0);

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      const objects = readPack(pack, store.lookup);
      for (const [oid, object] of objects) {
        if (!store.objects.has(oid)) store.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const useSideband = capabilities.split(' ').includes('side-band-64k');
  const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === ZERO_OID) {
        reportLines.push(`ng ${command.ref} reference does not exist\n`);
      } else if (command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} stale info\n`);
      } else {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    const object = store.getObject(command.newOid);
    if (object === undefined) {
      reportLines.push(`ng ${command.ref} missing object\n`);
      continue;
    }
    const isTagRef = command.ref.startsWith('refs/tags/');
    if (!isTagRef && object.type !== 'commit') {
      reportLines.push(`ng ${command.ref} not a commit\n`);
      continue;
    }
    if (current === ZERO_OID) {
      repo.refs.set(command.ref, command.newOid);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    if (isTagRef) {
      if (command.oldOid === current) {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      } else {
        reportLines.push(`ng ${command.ref} stale info\n`);
      }
      continue;
    }
    const currentCommit = peelToCommit(current);
    const newCommit = peelToCommit(command.newOid);
    if (currentCommit === null || newCommit === null || !isAncestor(store.lookup, currentCommit, newCommit)) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    if (command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} stale info\n`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }

  const inner = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  let responseBody: Buffer;
  if (useSideband) {
    const parts: Buffer[] = [];
    const CHUNK = 65519;
    for (let at = 0; at < inner.length; at += CHUNK) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), inner.subarray(at, Math.min(inner.length, at + CHUNK))])));
    }
    parts.push(PKT_FLUSH);
    responseBody = Buffer.concat(parts);
  } else {
    responseBody = inner;
  }
  return { status: 200, contentType, body: responseBody };
}
