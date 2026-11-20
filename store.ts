// The forge's single in-memory store, shared by the git, REST, GraphQL and MCP surfaces.
//
// Determinism: nothing here reads a wall clock or a random source. Timestamps come from a
// logical clock (a fixed base instant plus a sequential counter) and every id is a
// sequential number, so two runs that receive the same requests produce the same bytes.
//
// The token's owner: the suite's scenario is a fixed, published seed (the kit's wire
// contract), and the login the bearer token names is that scenario's viewer. The viewer,
// teammate, stranger and org logins are derived here from the same published generator
// (FNV-1a + splitmix64 + xorshift64*) so the forge agrees with the suite about who the
// token belongs to and which other logins are foreign (their repositories are 404).

import {
  buildTree,
  hashObject,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';

// ------------------------------------------------------------------ scenario identity

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class ScenarioRng {
  private state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4294967296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

function rngFor(label: string): ScenarioRng {
  return new ScenarioRng(mix64(SCENARIO_SEED ^ fnv1a64(label)));
}

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];
const REPO_ADJECTIVES: readonly string[] = [
  'amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly', 'keen', 'lively',
  'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft', 'steady', 'tidy', 'upbeat',
  'vivid', 'warm', 'witty', 'young', 'zesty',
];
const REPO_NOUNS: readonly string[] = [
  'acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon', 'glade', 'harbor',
  'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'raven',
  'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr',
];

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

function generateUsers(count: number): ScenarioUser[] {
  const rng = rngFor('users');
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

function generateOrg(): string {
  const rng = rngFor('org');
  return `${rng.pick(REPO_ADJECTIVES)}-${rng.pick(REPO_NOUNS)}-org`;
}

export const SCENARIO_USERS: readonly ScenarioUser[] = generateUsers(12);
export const VIEWER: ScenarioUser = SCENARIO_USERS[0] as ScenarioUser;
export const SCENARIO_ORG = generateOrg();

// ------------------------------------------------------------------ records

export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  authorLogin: string;
  createdSeq: number;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdSeq: number;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  createdSeq: number;
}

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  createdSeq: number;
}

/** The logical clock's base instant: 2025-01-01T00:00:00Z, plus one second per tick. */
const CLOCK_BASE_SEC = 1735689600;

export class Store {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, RepoRec>();
  readonly issueByGlobalId = new Map<number, { repo: RepoRec; issue: IssueRec }>();
  readonly pullByGlobalId = new Map<number, { repo: RepoRec; pull: PullRec }>();
  readonly commentByGlobalId = new Map<number, { repo: RepoRec; issue: IssueRec; comment: CommentRec }>();

  private repoSeq = 0;
  private issueSeq = 0;
  private pullSeq = 0;
  private commentSeq = 0;
  private orderSeq = 0;
  private clockSeq = 0;
  private requestSeq = 0;

  /** The next logical timestamp, as unix seconds. */
  tickSec(): number {
    this.clockSeq += 1;
    return CLOCK_BASE_SEC + this.clockSeq;
  }

  /** The next logical timestamp, as an ISO string. */
  tickIso(): string {
    return new Date(this.tickSec() * 1000).toISOString();
  }

  /** A git identity line ("Name <email> <unix> +0000") stamped with the logical clock. */
  identityLine(user: ScenarioUser): string {
    return `${user.name} <${user.email}> ${this.tickSec()} +0000`;
  }

  /** A monotonically increasing creation-order stamp. */
  nextOrder(): number {
    this.orderSeq += 1;
    return this.orderSeq;
  }

  /** A non-empty, unique-per-process request id for the X-GitHub-Request-Id header. */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `req-${this.requestSeq.toString(36)}`;
  }

  // -------------------------------------------------------------- objects

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  readonly lookup = (oid: string): GitObject | undefined => this.objects.get(oid);

  // -------------------------------------------------------------- repos

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, input: { description?: string; isPrivate?: boolean }): RepoRec {
    this.repoSeq += 1;
    const repo: RepoRec = {
      id: this.repoSeq,
      owner,
      name,
      description: input.description ?? '',
      isPrivate: input.isPrivate ?? false,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdSeq: this.nextOrder(),
    };
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  /** A repo by owner/name, but only when the owner is the token's login (else null: 404). */
  repoFor(owner: string, name: string): RepoRec | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(this.repoKey(owner, name)) ?? null;
  }

  repoById(id: number): RepoRec | null {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return null;
  }

  deleteRepo(repo: RepoRec): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  viewerRepos(): RepoRec[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner === VIEWER.login)
      .sort((a, b) => a.createdSeq - b.createdSeq);
  }

  // -------------------------------------------------------------- issues, pulls, comments

  createIssue(repo: RepoRec, input: { title: string; body: string; labels?: string[] }): IssueRec {
    this.issueSeq += 1;
    const issue: IssueRec = {
      id: this.issueSeq,
      number: repo.nextNumber,
      title: input.title,
      body: input.body,
      state: 'open',
      labels: [...(input.labels ?? [])],
      comments: [],
      createdSeq: this.nextOrder(),
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    this.issueByGlobalId.set(issue.id, { repo, issue });
    return issue;
  }

  createPull(repo: RepoRec, input: { title: string; body: string; headRef: string; baseRef: string }): PullRec {
    this.pullSeq += 1;
    const pull: PullRec = {
      id: this.pullSeq,
      number: repo.nextNumber,
      title: input.title,
      body: input.body,
      state: 'open',
      merged: false,
      mergeCommitSha: null,
      headRef: input.headRef,
      baseRef: input.baseRef,
      createdSeq: this.nextOrder(),
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    this.pullByGlobalId.set(pull.id, { repo, pull });
    return pull;
  }

  addComment(repo: RepoRec, issue: IssueRec, body: string): CommentRec {
    this.commentSeq += 1;
    const comment: CommentRec = {
      id: this.commentSeq,
      body,
      authorLogin: VIEWER.login,
      createdSeq: this.nextOrder(),
    };
    issue.comments.push(comment);
    this.commentByGlobalId.set(comment.id, { repo, issue, comment });
    return comment;
  }
}

/** The one store every surface shares. */
export const store = new Store();

// ------------------------------------------------------------------ tree helpers

/** Flatten a tree object into a map of full path -> {oid, mode}; empty map for no tree. */
export function flattenTree(treeOid: string | null): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  if (treeOid === null || treeOid === '') return out;
  const walk = (oid: string, prefix: string): void => {
    const object = store.getObject(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Build (and store) a tree hierarchy from a flattened path map; returns the root tree id. */
export function buildTreeFromFlat(flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i] as string;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return store.putObject('tree', buildTree(entries));
  };
  return build(root);
}

/** The tree id a commit points at, or null when the commit is unknown. */
export function commitTreeOid(commitOid: string): string | null {
  const object = store.getObject(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  const blank = object.data.indexOf('\n\n');
  const head = blank < 0 ? object.data : object.data.subarray(0, blank);
  for (const line of head.toString('utf8').split('\n')) {
    if (line.startsWith('tree ')) return line.slice(5).trim();
  }
  return null;
}

/** The flattened file map at a ref (branch name or full ref), or null when it does not resolve. */
export function flatTreeAtRef(repo: RepoRec, refName: string): Map<string, { oid: string; mode: string }> | null {
  const full = refName.startsWith('refs/') ? refName : `refs/heads/${refName}`;
  const tip = repo.refs.get(full);
  if (tip === undefined) return null;
  return flattenTree(commitTreeOid(tip));
}
