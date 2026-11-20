// The GraphQL v4 surface at /api/graphql: a small hand-written parser and executor
// covering the documents gh and github-mcp-server send — viewer, repository, issues
// and pull requests with cursor pagination, the create/close/merge mutations, Relay
// node(id:) reads, and the introspection probes (__type fields / enumValues).
// Unknown fields answer HTTP 200 with an errors array naming the field, as GitHub does.

import { decodeGlobalId, encodeGlobalId, isoFromSeq } from './ids.ts';
import { mergePull, pullFiles, pullMergeable } from './merge.ts';
import {
  store,
  VIEWER,
  type CommentRec,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

// ------------------------------------------------------------------ lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:@$!|=&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let value = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1] as string;
          const map: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            value += map[esc] ?? esc;
            i += 2;
          }
        } else {
          value += source[i];
          i += 1;
        }
      }
      if (i >= source.length) throw new Error('unterminated string');
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(i));
      if (match === null) throw new Error(`bad number at ${i}`);
      const text = match[0];
      tokens.push(text.includes('.') || /[eE]/.test(text) ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number.parseInt(text, 10) });
      i += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(i));
      const text = (match as RegExpExecArray)[0];
      tokens.push({ kind: 'name', value: text });
      i += text.length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// ------------------------------------------------------------------ parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'literal'; value: unknown }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
  variableDefaults: Map<string, Value>;
}

class Parser {
  private tokens: Token[];
  private at = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.at];
  }

  private next(): Token {
    const token = this.tokens[this.at];
    if (token === undefined) throw new Error('unexpected end of document');
    this.at += 1;
    return token;
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected "${value}"`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, SelectionNode[]> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.at < this.tokens.length) {
      const token = this.peek() as Token;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet(), variableDefaults: new Map() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected an operation or fragment');
      if (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription') {
        this.next();
        let name: string | null = null;
        const nextToken = this.peek();
        if (nextToken !== undefined && nextToken.kind === 'name') name = this.expectName();
        const variableDefaults = new Map<string, Value>();
        if (this.isPunct('(')) {
          this.next();
          while (!this.isPunct(')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            if (this.isPunct('=')) {
              this.next();
              variableDefaults.set(varName, this.parseValue());
            }
            if (this.isPunct('@')) this.skipDirectives();
          }
          this.next();
        }
        if (this.isPunct('@')) this.skipDirectives();
        operations.push({
          type: token.value === 'mutation' ? 'mutation' : 'query',
          name,
          selection: this.parseSelectionSet(),
          variableDefaults,
        });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const onToken = this.next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new Error('expected "on" in fragment');
        this.expectName();
        if (this.isPunct('@')) this.skipDirectives();
        fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.isPunct('[')) {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.isPunct('!')) this.next();
  }

  private skipDirectives(): void {
    while (this.isPunct('@')) {
      this.next();
      this.expectName();
      if (this.isPunct('(')) {
        this.next();
        while (!this.isPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
        this.next();
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.isPunct('}')) {
      if (this.isPunct('...')) {
        this.next();
        const token = this.peek();
        if (token !== undefined && token.kind === 'name' && token.value === 'on') {
          this.next();
          const condition = this.expectName();
          if (this.isPunct('@')) this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition: condition, selection: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.expectName() });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    this.next();
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.expectName();
    let alias: string | null = null;
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args = new Map<string, Value>();
    if (this.isPunct('(')) {
      this.next();
      while (!this.isPunct(')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.set(argName, this.parseValue());
      }
      this.next();
    }
    if (this.isPunct('@')) this.skipDirectives();
    const selection = this.isPunct('{') ? this.parseSelectionSet() : null;
    return { alias, name, args, selection };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.isPunct(']')) items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!this.isPunct('}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'literal', value: token.value };
    if (token.kind === 'int' || token.kind === 'float') return { kind: 'literal', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'literal', value: true };
      if (token.value === 'false') return { kind: 'literal', value: false };
      if (token.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'literal', value: token.value };
    }
    throw new Error('unexpected value token');
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'literal':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------ schema description (introspection)

const OBJECT_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', 'rateLimit', 'user', 'organization'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'createRepository'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'isPrivate', 'owner', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'hasPullRequestsEnabled', 'issue', 'issues', 'pullRequest',
    'pullRequests', 'url', 'homepageUrl', 'createdAt', 'updatedAt', 'pushedAt', 'stargazerCount', 'forkCount',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'createdAt', 'updatedAt',
    'closedAt', 'url', 'repository', 'locked', 'viewerDidAuthor',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName', 'baseRefName',
    'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt', 'closedAt', 'url', 'repository',
    'mergeCommit', 'isDraft', 'additions', 'deletions', 'changedFiles',
  ],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'databaseId', 'createdAt', 'updatedAt'],
  Organization: ['id', 'login', 'name', 'url'],
  Ref: ['id', 'name', 'prefix', 'target', 'repository'],
  GitObject: ['id', 'oid', 'type', 'abbreviatedOid'],
  Commit: ['id', 'oid', 'message', 'tree', 'parents', 'authoredDate'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'issue'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  SearchResultItemConnection: ['nodes', 'edges', 'pageInfo', 'issueCount'],
  RateLimit: ['limit', 'cost', 'remaining', 'resetAt', 'nodeCount'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
  __Type: ['kind', 'name', 'description', 'fields', 'inputFields', 'interfaces', 'enumValues', 'possibleTypes', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Directive: ['name', 'description', 'locations', 'args'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueCommentOrderField: ['CREATED_AT', 'UPDATED_AT'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
  FileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED'],
};

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'URI', 'DateTime', 'GitObjectID', 'HTML', 'Base64String']);

// ------------------------------------------------------------------ runtime values

interface GqlObject {
  __type: string;
  [key: string]: unknown;
}

function obj(type: string, fields: Record<string, unknown>): GqlObject {
  return { __type: type, ...fields };
}

function userObject(login: string): GqlObject {
  const user = login === VIEWER.login ? VIEWER : { id: 0, login, name: login, email: '' };
  return obj('User', { id: encodeGlobalId('User', user.id), databaseId: user.id, login: user.login, name: user.name, email: user.email });
}

function repoObject(repo: RepoRec): GqlObject {
  return obj('Repository', { repo });
}

function issueObject(repo: RepoRec, issue: IssueRec): GqlObject {
  return obj('Issue', { repo, issue });
}

function pullObject(repo: RepoRec, pull: PullRec): GqlObject {
  return obj('PullRequest', { repo, pull });
}

function commentObject(repo: RepoRec, issue: IssueRec, comment: CommentRec): GqlObject {
  return obj('IssueComment', { repo, issue, comment });
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const number = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isSafeInteger(number) ? number : null;
  } catch {
    return null;
  }
}

interface Connection {
  nodes: GqlObject[];
  totalCount: number;
  hasNextPage: boolean;
  endCursor: string | null;
  startCursor: string | null;
}

function paginateByCursor<T extends { number: number }>(
  ordered: T[],
  args: Map<string, unknown>,
  wrap: (item: T) => GqlObject,
): GqlObject {
  const firstRaw = args.get('first');
  const first = typeof firstRaw === 'number' && firstRaw > 0 ? Math.floor(firstRaw) : ordered.length;
  const afterNumber = numberFromCursor(args.get('after'));
  let start = 0;
  if (afterNumber !== null) {
    const index = ordered.findIndex((item) => item.number === afterNumber);
    if (index >= 0) start = index + 1;
  }
  const slice = ordered.slice(start, start + first);
  const connection: Connection = {
    nodes: slice.map(wrap),
    totalCount: ordered.length,
    hasNextPage: start + slice.length < ordered.length,
    endCursor: slice.length > 0 ? cursorFor((slice[slice.length - 1] as T).number) : null,
    startCursor: slice.length > 0 ? cursorFor((slice[0] as T).number) : null,
  };
  return obj('Connection', { connection, nodeNumbers: slice.map((item) => item.number) });
}

// ------------------------------------------------------------------ field resolution

class GqlFieldError extends Error {}

type Resolver = (source: GqlObject, args: Map<string, unknown>) => unknown;

function repoFields(): Record<string, Resolver> {
  return {
    id: (s) => encodeGlobalId('Repository', (s.repo as RepoRec).id),
    databaseId: (s) => (s.repo as RepoRec).id,
    name: (s) => (s.repo as RepoRec).name,
    nameWithOwner: (s) => `${(s.repo as RepoRec).owner}/${(s.repo as RepoRec).name}`,
    description: (s) => (s.repo as RepoRec).description,
    isPrivate: (s) => (s.repo as RepoRec).isPrivate,
    owner: (s) => userObject((s.repo as RepoRec).owner),
    defaultBranchRef: (s) => {
      const repo = s.repo as RepoRec;
      return obj('Ref', { name: repo.defaultBranch, prefix: 'refs/heads/', repo });
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    hasPullRequestsEnabled: () => true,
    url: () => '',
    createdAt: (s) => isoFromSeq((s.repo as RepoRec).createdSeq),
    updatedAt: (s) => isoFromSeq((s.repo as RepoRec).createdSeq),
    pushedAt: (s) => isoFromSeq((s.repo as RepoRec).createdSeq),
    stargazerCount: () => 0,
    forkCount: () => 0,
    issue: (s, args) => {
      const repo = s.repo as RepoRec;
      const number = args.get('number');
      const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
      return issue === undefined ? null : issueObject(repo, issue);
    },
    issues: (s, args) => {
      const repo = s.repo as RepoRec;
      let list = [...repo.issues.values()];
      const states = args.get('states');
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = args.get('orderBy') as { direction?: string } | undefined;
      const direction = orderBy?.direction === 'ASC' ? 'ASC' : orderBy?.direction === 'DESC' ? 'DESC' : 'ASC';
      list.sort((a, b) => (direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
      return paginateByCursor(list, args, (issue) => issueObject(repo, issue));
    },
    pullRequest: (s, args) => {
      const repo = s.repo as RepoRec;
      const number = args.get('number');
      const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
      return pull === undefined ? null : pullObject(repo, pull);
    },
    pullRequests: (s, args) => {
      const repo = s.repo as RepoRec;
      let list = [...repo.pulls.values()];
      const states = args.get('states');
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((state) => String(state)));
        list = list.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
      } else {
        list = list.filter((pull) => pull.state === 'open');
      }
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      return paginateByCursor(list, args, (pull) => pullObject(repo, pull));
    },
  };
}

function issueFields(): Record<string, Resolver> {
  return {
    id: (s) => encodeGlobalId('Issue', (s.issue as IssueRec).id),
    number: (s) => (s.issue as IssueRec).number,
    title: (s) => (s.issue as IssueRec).title,
    body: (s) => (s.issue as IssueRec).body,
    state: (s) => (s.issue as IssueRec).state.toUpperCase(),
    author: () => userObject(VIEWER.login),
    createdAt: (s) => isoFromSeq((s.issue as IssueRec).createdSeq),
    updatedAt: (s) => isoFromSeq((s.issue as IssueRec).createdSeq),
    closedAt: (s) => ((s.issue as IssueRec).state === 'closed' ? isoFromSeq((s.issue as IssueRec).createdSeq + 1) : null),
    url: () => '',
    locked: () => false,
    viewerDidAuthor: () => true,
    repository: (s) => repoObject(s.repo as RepoRec),
    labels: (s, args) => {
      const repo = s.repo as RepoRec;
      const issue = s.issue as IssueRec;
      const nodes = issue.labels
        .map((name) => repo.labels.get(name))
        .filter((label) => label !== undefined)
        .map((label) => obj('Label', { name: label.name, color: label.color, description: label.description }));
      void args;
      return obj('Connection', {
        connection: { nodes, totalCount: nodes.length, hasNextPage: false, endCursor: null, startCursor: null },
        nodeNumbers: [],
      });
    },
    comments: (s, args) => {
      const repo = s.repo as RepoRec;
      const issue = s.issue as IssueRec;
      const nodes = issue.comments.map((comment) => commentObject(repo, issue, comment));
      void args;
      return obj('Connection', {
        connection: { nodes, totalCount: nodes.length, hasNextPage: false, endCursor: null, startCursor: null },
        nodeNumbers: [],
      });
    },
  };
}

function pullFields(): Record<string, Resolver> {
  return {
    id: (s) => encodeGlobalId('PullRequest', (s.pull as PullRec).id),
    number: (s) => (s.pull as PullRec).number,
    title: (s) => (s.pull as PullRec).title,
    body: (s) => (s.pull as PullRec).body,
    state: (s) => {
      const pull = s.pull as PullRec;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (s) => (s.pull as PullRec).merged,
    mergedAt: (s) => ((s.pull as PullRec).merged ? isoFromSeq((s.pull as PullRec).createdSeq + 1) : null),
    mergeable: (s) => pullMergeable(s.repo as RepoRec, s.pull as PullRec),
    headRefName: (s) => (s.pull as PullRec).headRef,
    baseRefName: (s) => (s.pull as PullRec).baseRef,
    headRefOid: (s) => (s.repo as RepoRec).refs.get(`refs/heads/${(s.pull as PullRec).headRef}`) ?? '0'.repeat(40),
    baseRefOid: (s) => (s.repo as RepoRec).refs.get(`refs/heads/${(s.pull as PullRec).baseRef}`) ?? '0'.repeat(40),
    author: () => userObject(VIEWER.login),
    createdAt: (s) => isoFromSeq((s.pull as PullRec).createdSeq),
    updatedAt: (s) => isoFromSeq((s.pull as PullRec).createdSeq),
    closedAt: (s) => ((s.pull as PullRec).state === 'closed' ? isoFromSeq((s.pull as PullRec).createdSeq + 1) : null),
    url: () => '',
    isDraft: () => false,
    repository: (s) => repoObject(s.repo as RepoRec),
    mergeCommit: (s) => {
      const pull = s.pull as PullRec;
      return pull.mergeCommitSha === null ? null : obj('Commit', { oid: pull.mergeCommitSha });
    },
    additions: (s) => pullFiles(s.repo as RepoRec, s.pull as PullRec).reduce((sum, file) => sum + file.additions, 0),
    deletions: (s) => pullFiles(s.repo as RepoRec, s.pull as PullRec).reduce((sum, file) => sum + file.deletions, 0),
    changedFiles: (s) => pullFiles(s.repo as RepoRec, s.pull as PullRec).length,
    files: (s, args) => {
      const repo = s.repo as RepoRec;
      const pull = s.pull as PullRec;
      const all = pullFiles(repo, pull);
      const firstRaw = args.get('first');
      const first = typeof firstRaw === 'number' && firstRaw > 0 ? Math.floor(firstRaw) : all.length;
      const nodes = all.slice(0, first).map((file) =>
        obj('PullRequestChangedFile', {
          path: file.path,
          additions: file.additions,
          deletions: file.deletions,
          changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
        }),
      );
      return obj('Connection', {
        connection: { nodes, totalCount: all.length, hasNextPage: first < all.length, endCursor: null, startCursor: null },
        nodeNumbers: [],
      });
    },
  };
}

const TYPE_RESOLVERS: Record<string, Record<string, Resolver>> = {
  Repository: repoFields(),
  Issue: issueFields(),
  PullRequest: pullFields(),
  User: {
    id: (s) => s.id,
    login: (s) => s.login,
    name: (s) => s.name,
    email: (s) => s.email,
    databaseId: (s) => s.databaseId,
    url: () => '',
    avatarUrl: () => '',
    createdAt: () => isoFromSeq(0),
    updatedAt: () => isoFromSeq(0),
  },
  Ref: {
    id: (s) => encodeGlobalId('Repository', (s.repo as RepoRec).id),
    name: (s) => s.name,
    prefix: (s) => s.prefix,
    target: (s) => {
      const repo = s.repo as RepoRec;
      const oid = repo.refs.get(`refs/heads/${s.name as string}`) ?? '0'.repeat(40);
      return obj('GitObject', { oid });
    },
    repository: (s) => repoObject(s.repo as RepoRec),
  },
  GitObject: {
    id: (s) => s.oid,
    oid: (s) => s.oid,
    abbreviatedOid: (s) => String(s.oid).slice(0, 7),
    type: () => 'commit',
  },
  Commit: {
    id: (s) => s.oid,
    oid: (s) => s.oid,
    message: () => '',
  },
  Label: {
    id: (s) => encodeGlobalId('Label', 0),
    name: (s) => s.name,
    color: (s) => s.color,
    description: (s) => s.description,
  },
  IssueComment: {
    id: (s) => encodeGlobalId('IssueComment', (s.comment as CommentRec).id),
    body: (s) => (s.comment as CommentRec).body,
    author: (s) => userObject((s.comment as CommentRec).authorLogin),
    createdAt: (s) => isoFromSeq((s.comment as CommentRec).createdSeq),
    updatedAt: (s) => isoFromSeq((s.comment as CommentRec).createdSeq),
    url: () => '',
    issue: (s) => issueObject(s.repo as RepoRec, s.issue as IssueRec),
  },
  PullRequestChangedFile: {
    path: (s) => s.path,
    additions: (s) => s.additions,
    deletions: (s) => s.deletions,
    changeType: (s) => s.changeType,
  },
  Connection: {
    nodes: (s) => (s.connection as Connection).nodes,
    edges: (s) => {
      const connection = s.connection as Connection;
      const numbers = s.nodeNumbers as number[];
      return connection.nodes.map((node, index) => obj('Edge', { node, cursor: cursorFor(numbers[index] ?? index) }));
    },
    pageInfo: (s) => {
      const connection = s.connection as Connection;
      return obj('PageInfo', {
        hasNextPage: connection.hasNextPage,
        hasPreviousPage: false,
        startCursor: connection.startCursor,
        endCursor: connection.endCursor,
      });
    },
    totalCount: (s) => (s.connection as Connection).totalCount,
    issueCount: (s) => (s.connection as Connection).totalCount,
  },
  Edge: {
    node: (s) => s.node,
    cursor: (s) => s.cursor,
  },
  PageInfo: {
    hasNextPage: (s) => s.hasNextPage,
    hasPreviousPage: (s) => s.hasPreviousPage,
    startCursor: (s) => s.startCursor,
    endCursor: (s) => s.endCursor,
  },
  __Type: {
    kind: (s) => s.kind,
    name: (s) => s.name,
    description: () => null,
    fields: (s) => {
      const fields = OBJECT_FIELDS[s.name as string];
      if (fields === undefined) return null;
      return fields.map((name) => obj('__Field', { name }));
    },
    enumValues: (s) => {
      const values = ENUM_VALUES[s.name as string];
      if (values === undefined) return null;
      return values.map((name) => obj('__EnumValue', { name }));
    },
    possibleTypes: () => null,
    inputFields: () => null,
    interfaces: () => [],
    ofType: () => null,
  },
  __Field: {
    name: (s) => s.name,
    description: () => null,
    args: () => [],
    type: () => obj('__Type', { name: 'String', kind: 'SCALAR' }),
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __EnumValue: {
    name: (s) => s.name,
    description: () => null,
    isDeprecated: () => false,
    deprecationReason: () => null,
  },
  __Schema: {
    queryType: () => obj('__Type', { name: 'Query', kind: 'OBJECT' }),
    mutationType: () => obj('__Type', { name: 'Mutation', kind: 'OBJECT' }),
    subscriptionType: () => null,
    types: () => Object.keys(OBJECT_FIELDS).map((name) => obj('__Type', { name, kind: 'OBJECT' })),
    directives: () => [],
  },
  CreateIssuePayload: {
    issue: (s) => s.issue,
    clientMutationId: (s) => s.clientMutationId ?? null,
  },
  CloseIssuePayload: {
    issue: (s) => s.issue,
    clientMutationId: (s) => s.clientMutationId ?? null,
  },
  CreatePullRequestPayload: {
    pullRequest: (s) => s.pullRequest,
    clientMutationId: (s) => s.clientMutationId ?? null,
  },
  MergePullRequestPayload: {
    pullRequest: (s) => s.pullRequest,
    clientMutationId: (s) => s.clientMutationId ?? null,
  },
  AddCommentPayload: {
    commentEdge: (s) => s.commentEdge,
    subject: (s) => s.subject ?? null,
    clientMutationId: (s) => s.clientMutationId ?? null,
  },
  IssueCommentEdge: {
    node: (s) => s.node,
    cursor: (s) => s.cursor ?? '',
  },
};

// The connection wrapper's concrete type name depends on its parent in real GitHub;
// the checks only read nodes/pageInfo, so one generic resolver serves every connection.
function resolverFor(type: string, field: string): Resolver | undefined {
  if (type === 'Connection') return TYPE_RESOLVERS.Connection?.[field];
  if (type === 'Edge') return TYPE_RESOLVERS.Edge?.[field];
  return TYPE_RESOLVERS[type]?.[field];
}

function typeNameOf(value: unknown): string | null {
  if (typeof value === 'object' && value !== null && '__type' in value) {
    return (value as GqlObject).__type;
  }
  return null;
}

// ------------------------------------------------------------------ root fields

function nodeById(id: unknown): GqlObject | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  if (decoded.kind === 'Repository') {
    const repo = store.repoById(decoded.id);
    return repo !== null && repo.owner === VIEWER.login ? repoObject(repo) : null;
  }
  if (decoded.kind === 'Issue') {
    const found = store.issueByGlobalId.get(decoded.id);
    return found !== undefined ? issueObject(found.repo, found.issue) : null;
  }
  if (decoded.kind === 'PullRequest') {
    const found = store.pullByGlobalId.get(decoded.id);
    return found !== undefined ? pullObject(found.repo, found.pull) : null;
  }
  if (decoded.kind === 'IssueComment') {
    const found = store.commentByGlobalId.get(decoded.id);
    return found !== undefined ? commentObject(found.repo, found.issue, found.comment) : null;
  }
  if (decoded.kind === 'User') {
    return decoded.id === VIEWER.id ? userObject(VIEWER.login) : null;
  }
  return null;
}

function typeObject(name: string): GqlObject | null {
  if (OBJECT_FIELDS[name] !== undefined) return obj('__Type', { name, kind: 'OBJECT' });
  if (ENUM_VALUES[name] !== undefined) return obj('__Type', { name, kind: 'ENUM' });
  if (SCALARS.has(name)) return obj('__Type', { name, kind: 'SCALAR' });
  return null;
}

function resolveQueryField(name: string, args: Map<string, unknown>): unknown {
  switch (name) {
    case 'viewer':
      return userObject(VIEWER.login);
    case 'user': {
      const login = args.get('login');
      return login === VIEWER.login ? userObject(VIEWER.login) : null;
    }
    case 'repository': {
      const owner = args.get('owner');
      const repoName = args.get('name');
      if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
      const repo = store.repoFor(owner, repoName);
      return repo === null ? null : repoObject(repo);
    }
    case 'node':
      return nodeById(args.get('id'));
    case '__type': {
      const typeName = args.get('name');
      return typeof typeName === 'string' ? typeObject(typeName) : null;
    }
    case '__schema':
      return obj('__Schema', {});
    case 'rateLimit':
      return obj('RateLimit', { limit: 5000, cost: 1, remaining: 4999, nodeCount: 0 });
    case 'search':
      return obj('Connection', {
        connection: { nodes: [], totalCount: 0, hasNextPage: false, endCursor: null, startCursor: null },
        nodeNumbers: [],
      });
    default:
      throw new GqlFieldError(`Field '${name}' doesn't exist on type 'Query'`);
  }
}

function inputOf(args: Map<string, unknown>): Record<string, unknown> {
  const input = args.get('input');
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function resolveMutationField(name: string, args: Map<string, unknown>): unknown {
  const input = inputOf(args);
  const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
  switch (name) {
    case 'createIssue': {
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const repo = decoded !== null && decoded.kind === 'Repository' ? store.repoById(decoded.id) : null;
      if (repo === null || repo.owner !== VIEWER.login) throw new GqlFieldError('repositoryId does not name a repository');
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') throw new GqlFieldError('title is required');
      const issue = store.createIssue(repo, { title, body: typeof input.body === 'string' ? input.body : '' });
      return obj('CreateIssuePayload', { issue: issueObject(repo, issue), clientMutationId });
    }
    case 'closeIssue': {
      const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
      const found = decoded !== null && decoded.kind === 'Issue' ? store.issueByGlobalId.get(decoded.id) : undefined;
      if (found === undefined) throw new GqlFieldError('issueId does not name an issue');
      found.issue.state = 'closed';
      return obj('CloseIssuePayload', { issue: issueObject(found.repo, found.issue), clientMutationId });
    }
    case 'createPullRequest': {
      const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
      const repo = decoded !== null && decoded.kind === 'Repository' ? store.repoById(decoded.id) : null;
      if (repo === null || repo.owner !== VIEWER.login) throw new GqlFieldError('repositoryId does not name a repository');
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      if (!repo.refs.has(`refs/heads/${head}`)) throw new GqlFieldError(`head branch "${head}" does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) throw new GqlFieldError(`base branch "${base}" does not exist`);
      for (const pull of repo.pulls.values()) {
        if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
          return obj('CreatePullRequestPayload', { pullRequest: pullObject(repo, pull), clientMutationId });
        }
      }
      const pull = store.createPull(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        headRef: head,
        baseRef: base,
      });
      return obj('CreatePullRequestPayload', { pullRequest: pullObject(repo, pull), clientMutationId });
    }
    case 'mergePullRequest': {
      const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
      const found = decoded !== null && decoded.kind === 'PullRequest' ? store.pullByGlobalId.get(decoded.id) : undefined;
      if (found === undefined) throw new GqlFieldError('pullRequestId does not name a pull request');
      if (found.pull.state === 'open' && !found.pull.merged) {
        mergePull(found.repo, found.pull);
      }
      return obj('MergePullRequestPayload', { pullRequest: pullObject(found.repo, found.pull), clientMutationId });
    }
    case 'addComment': {
      const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
      const found = decoded !== null && decoded.kind === 'Issue' ? store.issueByGlobalId.get(decoded.id) : undefined;
      if (found === undefined) throw new GqlFieldError('subjectId does not name an issue');
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = store.addComment(found.repo, found.issue, body);
      return obj('AddCommentPayload', {
        commentEdge: obj('IssueCommentEdge', { node: commentObject(found.repo, found.issue, comment), cursor: cursorFor(found.issue.number) }),
        subject: issueObject(found.repo, found.issue),
        clientMutationId,
      });
    }
    default:
      throw new GqlFieldError(`Field '${name}' doesn't exist on type 'Mutation'`);
  }
}

// ------------------------------------------------------------------ validation + execution

const ROOT_FIELDS: Record<'query' | 'mutation', string[]> = {
  query: OBJECT_FIELDS.Query as string[],
  mutation: OBJECT_FIELDS.Mutation as string[],
};

function fieldsOfType(type: string): string[] | null {
  if (type === 'Connection' || type === 'Edge') return ['nodes', 'edges', 'pageInfo', 'totalCount', 'issueCount', 'node', 'cursor'];
  return OBJECT_FIELDS[type] ?? null;
}

function validateSelections(
  selections: SelectionNode[],
  type: string,
  fragments: Map<string, SelectionNode[]>,
  errors: Array<{ message: string }>,
): void {
  const known = fieldsOfType(type);
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      validateSelections(selection.selection, selection.typeCondition ?? type, fragments, errors);
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = fragments.get(selection.name);
      if (fragment !== undefined) validateSelections(fragment, type, fragments, errors);
      continue;
    }
    const field = selection.field;
    if (field.name === '__typename' || field.name === '__type' || field.name === '__schema') continue;
    if (known !== null && !known.includes(field.name)) {
      errors.push({ message: `Field '${field.name}' doesn't exist on type '${type}'` });
      continue;
    }
    if (field.selection !== null) {
      // Descend with a best-effort child type: connections and payloads resolve generically.
      const childType = childTypeOf(type, field.name);
      if (childType !== null) validateSelections(field.selection, childType, fragments, errors);
    }
  }
}

function childTypeOf(type: string, field: string): string | null {
  const byParent: Record<string, Record<string, string>> = {
    Query: {
      viewer: 'User', user: 'User', repository: 'Repository', node: 'Repository',
      __type: '__Type', __schema: '__Schema', search: 'Connection', rateLimit: 'RateLimit',
    },
    Mutation: {
      createIssue: 'CreateIssuePayload', closeIssue: 'CloseIssuePayload',
      createPullRequest: 'CreatePullRequestPayload', mergePullRequest: 'MergePullRequestPayload',
      addComment: 'AddCommentPayload',
    },
    Repository: {
      owner: 'User', defaultBranchRef: 'Ref', issue: 'Issue', issues: 'IssueConnection',
      pullRequest: 'PullRequest', pullRequests: 'PullRequestConnection',
    },
    Issue: { author: 'User', labels: 'LabelConnection', comments: 'IssueCommentConnection', repository: 'Repository' },
    PullRequest: {
      author: 'User', files: 'PullRequestChangedFileConnection', repository: 'Repository', mergeCommit: 'Commit',
    },
    IssueConnection: { nodes: 'Issue', edges: 'IssueEdge', pageInfo: 'PageInfo' },
    IssueEdge: { node: 'Issue' },
    PullRequestConnection: { nodes: 'PullRequest', edges: 'PullRequestEdge', pageInfo: 'PageInfo' },
    PullRequestEdge: { node: 'PullRequest' },
    PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile', edges: 'Edge', pageInfo: 'PageInfo' },
    LabelConnection: { nodes: 'Label', edges: 'Edge', pageInfo: 'PageInfo' },
    IssueCommentConnection: { nodes: 'IssueComment', edges: 'Edge', pageInfo: 'PageInfo' },
    CreateIssuePayload: { issue: 'Issue' },
    CloseIssuePayload: { issue: 'Issue' },
    CreatePullRequestPayload: { pullRequest: 'PullRequest' },
    MergePullRequestPayload: { pullRequest: 'PullRequest' },
    AddCommentPayload: { commentEdge: 'IssueCommentEdge', subject: 'Issue' },
    IssueCommentEdge: { node: 'IssueComment' },
    IssueComment: { author: 'User', issue: 'Issue' },
    Ref: { target: 'GitObject', repository: 'Repository' },
    __Type: { fields: '__Field', enumValues: '__EnumValue', type: '__Type' },
    __Field: { type: '__Type' },
    __Schema: { queryType: '__Type', mutationType: '__Type', types: '__Type' },
    Connection: { nodes: 'Repository', edges: 'Edge', pageInfo: 'PageInfo' },
    Edge: { node: 'Repository' },
  };
  return byParent[type]?.[field] ?? null;
}

interface ExecContext {
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: Array<{ message: string }>;
}

function executeSelectionSet(
  selections: SelectionNode[],
  source: unknown,
  type: string,
  ctx: ExecContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === type) {
        Object.assign(out, executeSelectionSet(selection.selection, source, selection.typeCondition ?? type, ctx));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) Object.assign(out, executeSelectionSet(fragment, source, type, ctx));
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = type;
      continue;
    }
    const args = new Map<string, unknown>();
    for (const [argName, argValue] of field.args) args.set(argName, resolveValue(argValue, ctx.variables));
    let value: unknown;
    try {
      value = resolveField(source, type, field.name, args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(value, field, ctx);
  }
  return out;
}

function resolveField(source: unknown, type: string, name: string, args: Map<string, unknown>): unknown {
  if (type === 'Query') return resolveQueryField(name, args);
  if (type === 'Mutation') return resolveMutationField(name, args);
  if (typeof source === 'object' && source !== null) {
    const resolver = resolverFor(type, name);
    if (resolver !== undefined) return resolver(source as GqlObject, args);
    // Fall back to a same-named plain property (payload and introspection objects).
    const record = source as Record<string, unknown>;
    if (name in record) return record[name];
  }
  throw new GqlFieldError(`Field '${name}' doesn't exist on type '${type}'`);
}

function completeValue(value: unknown, field: FieldNode, ctx: ExecContext): unknown {
  if (value === null || value === undefined) return null;
  if (field.selection === null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => completeValue(item, field, ctx));
  }
  const type = typeNameOf(value);
  if (type !== null) {
    const concrete = type === 'Connection' || type === 'Edge' ? type : type;
    return executeSelectionSet(field.selection, value, concrete, ctx);
  }
  return value;
}

/** Execute one operation document; returns the GraphQL envelope ({data} / {data, errors}). */
export function executeGraphQL(body: { query?: unknown; variables?: unknown; operationName?: unknown }): {
  data: unknown;
  errors?: Array<{ message: string }>;
} {
  const query = typeof body.query === 'string' ? body.query : '';
  if (query === '') return { data: null, errors: [{ message: 'a query document is required' }] };
  let document: { operations: OperationNode[]; fragments: Map<string, SelectionNode[]> };
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  if (document.operations.length === 0) return { data: null, errors: [{ message: 'no operation in the document' }] };
  let operation = document.operations[0] as OperationNode;
  if (typeof body.operationName === 'string' && body.operationName !== '') {
    const named = document.operations.find((candidate) => candidate.name === body.operationName);
    if (named !== undefined) operation = named;
  } else if (document.operations.length > 1) {
    return { data: null, errors: [{ message: 'an operationName is required for a multi-operation document' }] };
  }
  const variables: Record<string, unknown> = {};
  if (typeof body.variables === 'object' && body.variables !== null && !Array.isArray(body.variables)) {
    Object.assign(variables, body.variables as Record<string, unknown>);
  }
  for (const [name, defaultValue] of operation.variableDefaults) {
    if (variables[name] === undefined) variables[name] = resolveValue(defaultValue, variables);
  }
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const validationErrors: Array<{ message: string }> = [];
  validateSelections(operation.selection, rootType, document.fragments, validationErrors);
  if (validationErrors.length > 0) return { data: null, errors: validationErrors };
  const ctx: ExecContext = { variables, fragments: document.fragments, errors: [] };
  const data = executeSelectionSet(operation.selection, null, rootType, ctx);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}
