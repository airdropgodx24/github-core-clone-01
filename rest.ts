// The REST v3 surface under /api/v3: repositories, branches, commits, contents, the
// Git Data API, labels, issues, comments and pull requests. Every reply is JSON with a
// string `message` on errors; the app layer adds the request-id header and auth.

import { buildCommit, parseCommit, parseTree, ZERO_OID } from './gitobj.ts';
import { encodeGlobalId, isoFromSeq } from './ids.ts';
import { listCommits, mergePull, pullFiles } from './merge.ts';
import {
  buildTreeFromFlat,
  commitTreeOid,
  flattenTree,
  store,
  VIEWER,
  type IssueRec,
  type LabelRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

export interface RestReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RestContext {
  method: string;
  /** Path segments after /api/v3, percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  /** The parsed JSON body (undefined when the request carried none). */
  body: Record<string, unknown> | undefined;
  /** The request's own origin, for absolute pagination links. */
  origin: string;
}

const NOT_FOUND: RestReply = { status: 404, body: { message: 'Not Found' } };

function message(status: number, text: string): RestReply {
  return { status, body: { message: text } };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

// ------------------------------------------------------------------ serializers

export function userJson(login: string): Record<string, unknown> {
  const user = login === VIEWER.login ? VIEWER : { id: 0, login, name: login, email: '' };
  return { login: user.login, id: user.id, node_id: encodeGlobalId('User', user.id), type: 'User', site_admin: false };
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  let openCount = 0;
  for (const issue of repo.issues.values()) if (issue.state === 'open') openCount += 1;
  for (const pull of repo.pulls.values()) if (pull.state === 'open') openCount += 1;
  return {
    id: repo.id,
    node_id: encodeGlobalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: isoFromSeq(repo.createdSeq),
    updated_at: isoFromSeq(repo.createdSeq),
    html_url: '',
    clone_url: '',
    visibility: repo.isPrivate ? 'private' : 'public',
    has_issues: true,
    has_pull_requests: true,
    open_issues_count: openCount,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    language: null,
    archived: false,
  };
}

export function labelJson(label: LabelRec): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, default: false, url: '' };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: encodeGlobalId('Issue', issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels
      .map((name) => repo.labels.get(name))
      .filter((label): label is LabelRec => label !== undefined)
      .map(labelJson),
    user: userJson(VIEWER.login),
    comments: issue.comments.length,
    created_at: isoFromSeq(issue.createdSeq),
    updated_at: isoFromSeq(issue.createdSeq),
    closed_at: issue.state === 'closed' ? isoFromSeq(issue.createdSeq + 1) : null,
    html_url: '',
    repository_url: '',
  };
}

export function commentJson(comment: { id: number; body: string; authorLogin: string; createdSeq: number }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: encodeGlobalId('IssueComment', comment.id),
    body: comment.body,
    user: userJson(comment.authorLogin),
    created_at: isoFromSeq(comment.createdSeq),
    updated_at: isoFromSeq(comment.createdSeq),
    html_url: '',
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? ZERO_OID;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? ZERO_OID;
  return {
    id: pull.id,
    node_id: encodeGlobalId('PullRequest', pull.id),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.merged ? isoFromSeq(pull.createdSeq + 1) : null,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(VIEWER.login),
    created_at: isoFromSeq(pull.createdSeq),
    updated_at: isoFromSeq(pull.createdSeq),
    html_url: '',
    draft: false,
  };
}

function parseAuthorLine(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: isoFromSeq(0) };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(Number.parseInt(match[3] as string, 10) * 1000).toISOString(),
  };
}

export function commitJson(sha: string): Record<string, unknown> | null {
  const object = store.getObject(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  return {
    sha,
    node_id: encodeGlobalId('Repository', 0),
    commit: {
      author: parseAuthorLine(commit.author),
      committer: parseAuthorLine(commit.committer),
      message: commit.message,
      tree: { sha: commit.tree },
      comment_count: 0,
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    html_url: '',
  };
}

// ------------------------------------------------------------------ pagination

function paginate<T>(ctx: RestContext, items: T[], path: string): RestReply {
  const perPageRaw = Number.parseInt(ctx.query.get('per_page') ?? '', 10);
  const perPage = Number.isSafeInteger(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(ctx.query.get('page') ?? '', 10);
  const page = Number.isSafeInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const lastPage = Math.ceil(items.length / perPage);
    const next = `${ctx.origin}${path}?page=${page + 1}&per_page=${perPage}`;
    const last = `${ctx.origin}${path}?page=${lastPage}&per_page=${perPage}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return { status: 200, body: slice, headers };
}

// ------------------------------------------------------------------ contents commits

interface BranchWrite {
  ok: true;
  commitSha: string;
}

/** Commit one file change (or deletion, when blobOid is null) onto a branch, creating it when asked. */
function commitFileChange(
  repo: RepoRec,
  branch: string,
  path: string,
  blobOid: string | null,
  message: string,
): BranchWrite | RestReply {
  const ref = `refs/heads/${branch}`;
  let tip = repo.refs.get(ref);
  if (tip === undefined) {
    // A write to a branch that does not exist yet starts it from the default branch.
    tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }
  const flat = tip !== undefined ? flattenTree(commitTreeOid(tip)) : new Map<string, { oid: string; mode: string }>();
  if (blobOid === null) flat.delete(path);
  else flat.set(path, { oid: blobOid, mode: '100644' });
  const treeOid = buildTreeFromFlat(flat);
  const commitData = buildCommit({
    tree: treeOid,
    parents: tip !== undefined ? [tip] : [],
    message,
    author: store.identityLine(VIEWER),
  });
  const commitSha = store.putObject('commit', commitData);
  repo.refs.set(ref, commitSha);
  return { ok: true, commitSha };
}

/** Resolve a ref parameter (branch name, full ref, or commit id) to a commit id. */
function resolveRef(repo: RepoRec, ref: string | null): string | null {
  if (ref === null || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return byBranch;
  const byFull = repo.refs.get(ref);
  if (byFull !== undefined) return byFull;
  const object = store.getObject(ref);
  if (object !== undefined && object.type === 'commit') return ref;
  return null;
}

// ------------------------------------------------------------------ route handlers

function createRepo(ctx: RestContext): RestReply {
  const body = asRecord(ctx.body);
  const name = stringOf(body.name);
  if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
    return message(422, 'Validation Failed: a repository name is required');
  }
  if (store.repos.has(store.repoKey(VIEWER.login, name))) {
    return message(422, 'Validation Failed: name already exists on this account');
  }
  const repo = store.createRepo(VIEWER.login, name, {
    description: stringOf(body.description),
    isPrivate: body.private === true,
  });
  return { status: 201, body: repoJson(repo) };
}

function contentsGet(repo: RepoRec, ctx: RestContext, path: string): RestReply {
  const tip = resolveRef(repo, ctx.query.get('ref'));
  if (tip === null) return NOT_FOUND;
  const treeOid = commitTreeOid(tip);
  if (treeOid === null) return NOT_FOUND;
  // Walk to the requested node.
  let currentTree: string | null = treeOid;
  let fileEntry: { oid: string; mode: string } | null = null;
  const segments = path === '' ? [] : path.split('/');
  for (let i = 0; i < segments.length; i += 1) {
    if (currentTree === null) return NOT_FOUND;
    const treeObject = store.getObject(currentTree);
    if (treeObject === undefined || treeObject.type !== 'tree') return NOT_FOUND;
    const entry = parseTree(treeObject.data).find((candidate) => candidate.name === segments[i]);
    if (entry === undefined) return NOT_FOUND;
    if (i === segments.length - 1) {
      if (entry.mode === '40000') currentTree = entry.oid;
      else fileEntry = { oid: entry.oid, mode: entry.mode };
    } else {
      if (entry.mode !== '40000') return NOT_FOUND;
      currentTree = entry.oid;
    }
  }
  const name = segments.length === 0 ? '' : (segments[segments.length - 1] as string);
  if (fileEntry !== null) {
    const blob = store.getObject(fileEntry.oid);
    if (blob === undefined) return NOT_FOUND;
    return {
      status: 200,
      body: {
        type: 'file',
        name,
        path,
        sha: fileEntry.oid,
        size: blob.data.length,
        encoding: 'base64',
        content: blob.data.toString('base64'),
        html_url: '',
        download_url: '',
      },
    };
  }
  if (currentTree === null) return NOT_FOUND;
  const treeObject = store.getObject(currentTree);
  if (treeObject === undefined || treeObject.type !== 'tree') return NOT_FOUND;
  const entries = parseTree(treeObject.data).map((entry) => {
    const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
    const child = store.getObject(entry.oid);
    return {
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: childPath,
      sha: entry.oid,
      size: child !== undefined && child.type === 'blob' ? child.data.length : 0,
      html_url: '',
    };
  });
  return { status: 200, body: entries };
}

function contentsPut(repo: RepoRec, ctx: RestContext, path: string): RestReply {
  const body = asRecord(ctx.body);
  const contentBase64 = stringOf(body.content);
  const messageText = stringOf(body.message) || 'Update file';
  const branch = stringOf(body.branch) || repo.defaultBranch;
  const bytes = Buffer.from(contentBase64.replace(/[\r\n\t ]+/g, ''), 'base64');
  const blobOid = store.putObject('blob', bytes);
  const tip = resolveRef(repo, branch === repo.defaultBranch ? null : branch);
  const flat = tip !== null ? flattenTree(commitTreeOid(tip)) : new Map<string, { oid: string; mode: string }>();
  const existing = flat.get(path);
  const givenSha = stringOf(body.sha);
  if (existing !== undefined) {
    if (givenSha !== '' && givenSha !== existing.oid) {
      return message(409, 'Conflict: the sha does not match the current file');
    }
    if (givenSha === '' ) {
      return message(422, 'Validation Failed: sha is required when updating a file');
    }
  }
  const written = commitFileChange(repo, branch, path, blobOid, messageText);
  if ('status' in written) return written;
  return {
    status: existing !== undefined ? 200 : 201,
    body: {
      content: { type: 'file', name: path.split('/').pop() ?? path, path, sha: blobOid, encoding: 'base64' },
      commit: { sha: written.commitSha },
    },
  };
}

function contentsDelete(repo: RepoRec, ctx: RestContext, path: string): RestReply {
  const body = asRecord(ctx.body);
  const branch = stringOf(body.branch) || repo.defaultBranch;
  const tip = resolveRef(repo, branch);
  const flat = tip !== null ? flattenTree(commitTreeOid(tip)) : new Map<string, { oid: string; mode: string }>();
  const existing = flat.get(path);
  if (existing === undefined) return NOT_FOUND;
  const givenSha = stringOf(body.sha);
  if (givenSha !== '' && givenSha !== existing.oid) {
    return message(409, 'Conflict: the sha does not match the current file');
  }
  const written = commitFileChange(repo, branch, path, null, stringOf(body.message) || 'Delete file');
  if ('status' in written) return written;
  return { status: 200, body: { content: null, commit: { sha: written.commitSha } } };
}

// ------------------------------------------------------------------ git data API

function gitData(repo: RepoRec, ctx: RestContext, rest: string[]): RestReply {
  const body = asRecord(ctx.body);
  const [head, ...tail] = rest;
  if (head === 'refs') {
    if (ctx.method === 'POST' && tail.length === 0) {
      const ref = stringOf(body.ref);
      const sha = stringOf(body.sha);
      if (!ref.startsWith('refs/') || store.getObject(sha) === undefined) {
        return message(422, 'Validation Failed: ref and a valid sha are required');
      }
      if (repo.refs.has(ref)) return message(422, 'Validation Failed: Reference already exists');
      repo.refs.set(ref, sha);
      const object = store.getObject(sha) as { type: string };
      return { status: 201, body: { ref, node_id: '', url: '', object: { sha, type: object.type } } };
    }
    if (ctx.method === 'GET' && tail.length === 0) {
      const list = [...repo.refs.entries()].map(([ref, sha]) => ({
        ref,
        object: { sha, type: store.getObject(sha)?.type ?? 'commit' },
      }));
      return { status: 200, body: list };
    }
    const ref = `refs/${tail.join('/')}`;
    const sha = repo.refs.get(ref);
    if (ctx.method === 'GET') {
      if (sha === undefined) return NOT_FOUND;
      return { status: 200, body: { ref, node_id: '', url: '', object: { sha, type: store.getObject(sha)?.type ?? 'commit' } } };
    }
    if (ctx.method === 'DELETE') {
      if (sha === undefined) return NOT_FOUND;
      repo.refs.delete(ref);
      return { status: 204 };
    }
    return NOT_FOUND;
  }
  if (head === 'ref' && ctx.method === 'GET') {
    const ref = tail.join('/');
    const sha = repo.refs.get(ref);
    if (sha === undefined) return NOT_FOUND;
    return { status: 200, body: { ref, object: { sha, type: store.getObject(sha)?.type ?? 'commit' } } };
  }
  if (head === 'blobs') {
    if (ctx.method === 'POST' && tail.length === 0) {
      const encoding = stringOf(body.encoding) || 'utf-8';
      const raw = stringOf(body.content);
      const bytes = encoding === 'base64' ? Buffer.from(raw.replace(/[\r\n\t ]+/g, ''), 'base64') : Buffer.from(raw, 'utf8');
      const sha = store.putObject('blob', bytes);
      return { status: 201, body: { sha, url: '' } };
    }
    if (ctx.method === 'GET' && tail.length === 1) {
      const object = store.getObject(tail[0] as string);
      if (object === undefined || object.type !== 'blob') return NOT_FOUND;
      return { status: 200, body: { sha: tail[0], content: object.data.toString('base64'), encoding: 'base64', size: object.data.length } };
    }
    return NOT_FOUND;
  }
  if (head === 'trees') {
    if (ctx.method === 'POST' && tail.length === 0) {
      const flat = new Map<string, { oid: string; mode: string }>();
      const baseTree = stringOf(body.base_tree);
      if (baseTree !== '') {
        for (const [path, entry] of flattenTree(baseTree)) flat.set(path, entry);
      }
      const entries = Array.isArray(body.tree) ? body.tree : [];
      for (const rawEntry of entries) {
        const entry = asRecord(rawEntry);
        const path = stringOf(entry.path);
        if (path === '') continue;
        let sha = stringOf(entry.sha);
        if (sha === '' && typeof entry.content === 'string') {
          sha = store.putObject('blob', Buffer.from(entry.content, 'utf8'));
        }
        if (sha === '' || store.getObject(sha) === undefined) {
          return message(422, `Validation Failed: tree entry ${path} names an unknown object`);
        }
        flat.set(path, { oid: sha, mode: stringOf(entry.mode) || '100644' });
      }
      const sha = buildTreeFromFlat(flat);
      return { status: 201, body: { sha, url: '', tree: [], truncated: false } };
    }
    if (ctx.method === 'GET' && tail.length === 1) {
      const object = store.getObject(tail[0] as string);
      if (object === undefined || object.type !== 'tree') return NOT_FOUND;
      const recursive = ctx.query.get('recursive') === '1' || ctx.query.get('recursive') === 'true';
      if (recursive) {
        const flat = flattenTree(tail[0] as string);
        const tree = [...flat.entries()].map(([path, entry]) => ({
          path,
          mode: entry.mode,
          type: 'blob',
          sha: entry.oid,
          size: store.getObject(entry.oid)?.data.length ?? 0,
        }));
        return { status: 200, body: { sha: tail[0], url: '', tree, truncated: false } };
      }
      const tree = parseTree(object.data).map((entry) => ({
        path: entry.name,
        mode: entry.mode,
        type: entry.mode === '40000' ? 'tree' : 'blob',
        sha: entry.oid,
      }));
      return { status: 200, body: { sha: tail[0], url: '', tree, truncated: false } };
    }
    return NOT_FOUND;
  }
  if (head === 'commits') {
    if (ctx.method === 'POST' && tail.length === 0) {
      const tree = stringOf(body.tree);
      if (store.getObject(tree)?.type !== 'tree') return message(422, 'Validation Failed: a valid tree is required');
      const parents = Array.isArray(body.parents) ? body.parents.filter((p): p is string => typeof p === 'string') : [];
      const data = buildCommit({
        tree,
        parents,
        message: stringOf(body.message),
        author: store.identityLine(VIEWER),
      });
      const sha = store.putObject('commit', data);
      const json = commitJson(sha);
      return { status: 201, body: json ?? { sha } };
    }
    if (ctx.method === 'GET' && tail.length === 1) {
      const json = commitJson(tail[0] as string);
      return json === null ? NOT_FOUND : { status: 200, body: json };
    }
    return NOT_FOUND;
  }
  if (head === 'tags' && ctx.method === 'POST' && tail.length === 0) {
    const target = stringOf(body.object);
    const targetObject = store.getObject(target);
    if (targetObject === undefined) return message(422, 'Validation Failed: a valid object is required');
    const tagger = store.identityLine(VIEWER);
    const data = Buffer.from(
      `object ${target}\ntype ${stringOf(body.type) || targetObject.type}\ntag ${stringOf(body.tag)}\ntagger ${tagger}\n\n${stringOf(body.message)}`,
      'utf8',
    );
    const sha = store.putObject('tag', data);
    return { status: 201, body: { tag: stringOf(body.tag), sha, object: { sha: target, type: targetObject.type } } };
  }
  return NOT_FOUND;
}

// ------------------------------------------------------------------ issues and pulls

function labelNamesOf(body: Record<string, unknown>): string[] {
  const raw = body.labels;
  if (!Array.isArray(raw)) return [];
  const names: string[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') names.push(entry);
    else {
      const name = stringOf(asRecord(entry).name);
      if (name !== '') names.push(name);
    }
  }
  return names;
}

function issuesRoute(repo: RepoRec, ctx: RestContext, rest: string[]): RestReply {
  const body = asRecord(ctx.body);
  if (rest.length === 0) {
    if (ctx.method === 'POST') {
      const title = stringOf(body.title);
      if (title === '') return message(422, 'Validation Failed: a title is required');
      const labels = labelNamesOf(body);
      for (const name of labels) {
        if (!repo.labels.has(name)) return message(422, `Validation Failed: label "${name}" does not exist`);
      }
      const issue = store.createIssue(repo, { title, body: stringOf(body.body), labels });
      return { status: 201, body: issueJson(repo, issue) };
    }
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const direction = ctx.query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      return paginate(ctx, list.map((issue) => issueJson(repo, issue)), `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
    }
    return NOT_FOUND;
  }
  const number = Number.parseInt(rest[0] as string, 10);
  const issue = Number.isSafeInteger(number) ? repo.issues.get(number) : undefined;
  if (rest.length === 1) {
    if (issue === undefined) return NOT_FOUND;
    if (ctx.method === 'GET') return { status: 200, body: issueJson(repo, issue) };
    if (ctx.method === 'PATCH') {
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (body.labels !== undefined) {
        const labels = labelNamesOf(body);
        for (const name of labels) {
          if (!repo.labels.has(name)) return message(422, `Validation Failed: label "${name}" does not exist`);
        }
        issue.labels = labels;
      }
      return { status: 200, body: issueJson(repo, issue) };
    }
    return NOT_FOUND;
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (issue === undefined) return NOT_FOUND;
    if (ctx.method === 'POST') {
      const text = stringOf(body.body);
      if (text === '') return message(422, 'Validation Failed: a comment body is required');
      const comment = store.addComment(repo, issue, text);
      return { status: 201, body: commentJson(comment) };
    }
    if (ctx.method === 'GET') {
      return { status: 200, body: issue.comments.map((comment) => commentJson(comment)) };
    }
    return NOT_FOUND;
  }
  return NOT_FOUND;
}

function pullsRoute(repo: RepoRec, ctx: RestContext, rest: string[]): RestReply {
  const body = asRecord(ctx.body);
  if (rest.length === 0) {
    if (ctx.method === 'POST') {
      const title = stringOf(body.title);
      const headRaw = stringOf(body.head);
      const baseRaw = stringOf(body.base);
      const head = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
      const base = baseRaw.includes(':') ? (baseRaw.split(':').pop() as string) : baseRaw;
      if (title === '' || head === '' || base === '') {
        return message(422, 'Validation Failed: title, head and base are required');
      }
      if (!repo.refs.has(`refs/heads/${head}`)) return message(422, `Validation Failed: head branch "${head}" does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) return message(422, `Validation Failed: base branch "${base}" does not exist`);
      for (const pull of repo.pulls.values()) {
        if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) {
          return message(422, 'Validation Failed: a pull request already exists for this head and base');
        }
      }
      const pull = store.createPull(repo, { title, body: stringOf(body.body), headRef: head, baseRef: base });
      return { status: 201, body: pullJson(repo, pull) };
    }
    if (ctx.method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state === 'open') list = list.filter((pull) => pull.state === 'open');
      else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      return paginate(ctx, list.map((pull) => pullJson(repo, pull)), `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
    }
    return NOT_FOUND;
  }
  const number = Number.parseInt(rest[0] as string, 10);
  const pull = Number.isSafeInteger(number) ? repo.pulls.get(number) : undefined;
  if (rest.length === 1 && ctx.method === 'GET') {
    if (pull === undefined) return NOT_FOUND;
    return { status: 200, body: pullJson(repo, pull) };
  }
  if (rest.length === 2 && rest[1] === 'files' && ctx.method === 'GET') {
    if (pull === undefined) return NOT_FOUND;
    const files = pullFiles(repo, pull).map((file) => ({
      filename: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    }));
    return { status: 200, body: files };
  }
  if (rest.length === 2 && rest[1] === 'merge' && ctx.method === 'PUT') {
    if (pull === undefined) return NOT_FOUND;
    if (pull.merged || pull.state !== 'open') return message(405, 'Pull Request is not mergeable');
    const outcome = mergePull(repo, pull);
    if (!outcome.ok) {
      if (outcome.reason === 'conflict') return message(405, 'Pull Request is not mergeable: conflicts must be resolved first');
      return message(405, 'Pull Request is not mergeable');
    }
    return { status: 200, body: { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' } };
  }
  return NOT_FOUND;
}

// ------------------------------------------------------------------ the router

export function handleRest(ctx: RestContext): RestReply {
  const segments = ctx.segments;
  const body = asRecord(ctx.body);

  if (segments.length === 0) {
    if (ctx.method === 'GET') {
      return {
        status: 200,
        body: {
          current_user_url: '/api/v3/user',
          repository_url: '/api/v3/repos/{owner}/{repo}',
          issue_search_url: '/api/v3/search/issues',
        },
        headers: { 'x-oauth-scopes': 'repo, read:org' },
      };
    }
    return NOT_FOUND;
  }

  if (segments[0] === 'meta' && segments.length === 1 && ctx.method === 'GET') {
    return { status: 200, body: { installed_version: '1.0.0', verifiable_password_authentication: false } };
  }

  if (segments[0] === 'user' && segments.length === 1 && ctx.method === 'GET') {
    return { status: 200, body: userJson(VIEWER.login) };
  }

  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (ctx.method === 'POST') return createRepo(ctx);
    if (ctx.method === 'GET') {
      return paginate(ctx, store.viewerRepos().map(repoJson), '/api/v3/user/repos');
    }
    return NOT_FOUND;
  }

  if (segments[0] === 'users' && segments.length === 3 && segments[2] === 'repos' && ctx.method === 'GET') {
    if (segments[1] !== VIEWER.login) return NOT_FOUND;
    return paginate(ctx, store.viewerRepos().map(repoJson), `/api/v3/users/${VIEWER.login}/repos`);
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const repo = store.repoFor(owner, name);
    if (repo === null) return NOT_FOUND;
    const rest = segments.slice(3);
    if (rest.length === 0) {
      if (ctx.method === 'GET') return { status: 200, body: repoJson(repo) };
      if (ctx.method === 'PATCH') {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
        if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name) {
          // A rename moves the map key; the suite never renames, but stay consistent.
          store.repos.delete(store.repoKey(repo.owner, repo.name));
          repo.name = body.name;
          store.repos.set(store.repoKey(repo.owner, repo.name), repo);
        }
        return { status: 200, body: repoJson(repo) };
      }
      if (ctx.method === 'DELETE') {
        store.deleteRepo(repo);
        return { status: 204 };
      }
      return NOT_FOUND;
    }
    if (rest[0] === 'branches') {
      if (rest.length === 1 && ctx.method === 'GET') {
        const branches = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }));
        return { status: 200, body: branches };
      }
      if (rest.length >= 2 && ctx.method === 'GET') {
        const branch = rest.slice(1).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) return NOT_FOUND;
        return { status: 200, body: { name: branch, commit: { sha }, protected: false } };
      }
      return NOT_FOUND;
    }
    if (rest[0] === 'commits' && rest.length === 1 && ctx.method === 'GET') {
      const tip = resolveRef(repo, ctx.query.get('sha'));
      if (tip === null) return { status: 200, body: [] };
      const commits = listCommits(tip, 250)
        .map((entry) => commitJson(entry.sha))
        .filter((json): json is Record<string, unknown> => json !== null);
      return { status: 200, body: commits };
    }
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      if (ctx.method === 'GET') return contentsGet(repo, ctx, path);
      if (ctx.method === 'PUT') return contentsPut(repo, ctx, path);
      if (ctx.method === 'DELETE') return contentsDelete(repo, ctx, path);
      return NOT_FOUND;
    }
    if (rest[0] === 'labels') {
      if (rest.length === 1) {
        if (ctx.method === 'POST') {
          const labelName = stringOf(body.name);
          if (labelName === '') return message(422, 'Validation Failed: a label name is required');
          if (repo.labels.has(labelName)) return message(422, 'Validation Failed: label already exists');
          const label: LabelRec = {
            name: labelName,
            color: stringOf(body.color) || 'ededed',
            description: typeof body.description === 'string' ? body.description : null,
          };
          repo.labels.set(labelName, label);
          return { status: 201, body: labelJson(label) };
        }
        if (ctx.method === 'GET') return { status: 200, body: [...repo.labels.values()].map(labelJson) };
        return NOT_FOUND;
      }
      if (rest.length === 2 && ctx.method === 'GET') {
        const label = repo.labels.get(rest[1] as string);
        return label === undefined ? NOT_FOUND : { status: 200, body: labelJson(label) };
      }
      return NOT_FOUND;
    }
    if (rest[0] === 'issues') return issuesRoute(repo, ctx, rest.slice(1));
    if (rest[0] === 'pulls') return pullsRoute(repo, ctx, rest.slice(1));
    if (rest[0] === 'git') return gitData(repo, ctx, rest.slice(1));
    return NOT_FOUND;
  }

  return NOT_FOUND;
}
