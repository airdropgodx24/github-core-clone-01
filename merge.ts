// Pull-request merge machinery shared by REST, GraphQL and MCP: merge-base discovery,
// three-way tree merges with per-path conflict detection, changed-file listings with
// line counts, and the squash merge itself (one new commit on the base branch whose
// tree is the merged tree).

import { buildCommit, mergeBase, parseCommit } from './gitobj.ts';
import {
  buildTreeFromFlat,
  commitTreeOid,
  flattenTree,
  store,
  VIEWER,
  type PullRec,
  type RepoRec,
} from './store.ts';

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function lineMultiset(data: Buffer): Map<string, number> {
  const counts = new Map<string, number>();
  const text = data.toString('utf8');
  if (text === '') return counts;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return counts;
}

function lineDelta(before: Buffer, after: Buffer): { additions: number; deletions: number } {
  const oldLines = lineMultiset(before);
  const newLines = lineMultiset(after);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newLines) {
    const extra = count - (oldLines.get(line) ?? 0);
    if (extra > 0) additions += extra;
  }
  for (const [line, count] of oldLines) {
    const extra = count - (newLines.get(line) ?? 0);
    if (extra > 0) deletions += extra;
  }
  return { additions, deletions };
}

function blobData(oid: string): Buffer {
  const object = store.getObject(oid);
  return object !== undefined && object.type === 'blob' ? object.data : Buffer.alloc(0);
}

/** The files that differ between two flattened trees, with line-level counts. */
export function diffFlat(
  before: ReadonlyMap<string, { oid: string; mode: string }>,
  after: ReadonlyMap<string, { oid: string; mode: string }>,
): FileChange[] {
  const changes: FileChange[] = [];
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry !== undefined && newEntry !== undefined) {
      if (oldEntry.oid === newEntry.oid && oldEntry.mode === newEntry.mode) continue;
      const delta = lineDelta(blobData(oldEntry.oid), blobData(newEntry.oid));
      changes.push({ path, status: 'modified', additions: delta.additions, deletions: delta.deletions, changes: delta.additions + delta.deletions });
    } else if (newEntry !== undefined) {
      const delta = lineDelta(Buffer.alloc(0), blobData(newEntry.oid));
      changes.push({ path, status: 'added', additions: delta.additions, deletions: 0, changes: delta.additions });
    } else if (oldEntry !== undefined) {
      const delta = lineDelta(blobData(oldEntry.oid), Buffer.alloc(0));
      changes.push({ path, status: 'removed', additions: 0, deletions: delta.deletions, changes: delta.deletions });
    }
  }
  return changes;
}

export interface MergePlan {
  /** The merge-base commit the two tips share, or null when they share no history. */
  base: string | null;
  /** The flattened merged tree, present when the merge is clean. */
  mergedFlat: Map<string, { oid: string; mode: string }> | null;
  /** One path that both sides changed incompatibly, when the merge conflicts. */
  conflictPath: string | null;
}

/** Plan the merge of `headTip` into `baseTip`: three-way over their flattened trees. */
export function planMerge(headTip: string, baseTip: string): MergePlan {
  const base = mergeBase(store.lookup, baseTip, headTip);
  if (base === null) return { base: null, mergedFlat: null, conflictPath: null };
  const baseFlat = flattenTree(commitTreeOid(base));
  const oursFlat = flattenTree(commitTreeOid(baseTip));
  const theirsFlat = flattenTree(commitTreeOid(headTip));
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set<string>([...baseFlat.keys(), ...oursFlat.keys(), ...theirsFlat.keys()]);
  for (const path of paths) {
    const inBase = baseFlat.get(path);
    const inOurs = oursFlat.get(path);
    const inTheirs = theirsFlat.get(path);
    const sameEntry = (a?: { oid: string; mode: string }, b?: { oid: string; mode: string }): boolean =>
      (a === undefined && b === undefined) || (a !== undefined && b !== undefined && a.oid === b.oid && a.mode === b.mode);
    let winner: { oid: string; mode: string } | undefined;
    if (sameEntry(inOurs, inTheirs)) winner = inOurs;
    else if (sameEntry(inBase, inOurs)) winner = inTheirs;
    else if (sameEntry(inBase, inTheirs)) winner = inOurs;
    else return { base, mergedFlat: null, conflictPath: path };
    if (winner !== undefined) merged.set(path, winner);
  }
  return { base, mergedFlat: merged, conflictPath: null };
}

/** Whether an open pull request would merge cleanly right now. */
export function pullMergeable(repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
  const plan = planMerge(headTip, baseTip);
  if (plan.base === null) return 'UNKNOWN';
  return plan.mergedFlat !== null ? 'MERGEABLE' : 'CONFLICTING';
}

/** The changed files of a pull request: merge-base tree versus head tree. */
export function pullFiles(repo: RepoRec, pull: PullRec): FileChange[] {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return [];
  const base = mergeBase(store.lookup, baseTip, headTip);
  const before = base !== null ? flattenTree(commitTreeOid(base)) : new Map<string, { oid: string; mode: string }>();
  const after = flattenTree(commitTreeOid(headTip));
  return diffFlat(before, after);
}

export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: 'not-found' | 'conflict' | 'not-open' | 'missing-ref' };

/**
 * Squash-merge a pull request: one new commit on the base branch carrying the merged
 * tree, the pull marked closed + merged with that commit as its merge_commit_sha.
 */
export function mergePull(repo: RepoRec, pull: PullRec): MergeOutcome {
  if (pull.state !== 'open' || pull.merged) return { ok: false, reason: 'not-open' };
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return { ok: false, reason: 'missing-ref' };
  const plan = planMerge(headTip, baseTip);
  if (plan.base === null) return { ok: false, reason: 'conflict' };
  if (plan.mergedFlat === null) return { ok: false, reason: 'conflict' };
  const treeOid = buildTreeFromFlat(plan.mergedFlat);
  const message = pull.body !== '' ? `${pull.title}\n\n${pull.body}\n` : `${pull.title}\n`;
  const commitData = buildCommit({
    tree: treeOid,
    parents: [baseTip],
    message,
    author: store.identityLine(VIEWER),
  });
  const sha = store.putObject('commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  return { ok: true, sha };
}

/** The commits reachable from a tip, newest first (first-parent order is not imposed). */
export function listCommits(tip: string, limit: number): Array<{ sha: string; message: string; tree: string; parents: string[]; author: string; committer: string }> {
  const out: Array<{ sha: string; message: string; tree: string; parents: string[]; author: string; committer: string }> = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0 && out.length < limit) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.getObject(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    out.push({ sha: oid, message: commit.message, tree: commit.tree, parents: commit.parents, author: commit.author, committer: commit.committer });
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}
