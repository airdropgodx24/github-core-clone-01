// The MCP surface at /mcp: JSON-RPC 2.0 over Streamable HTTP. Speaks the modern
// server/discover handshake (protocol revision 2026-07-28) and the legacy
// initialize handshake, and exposes github-mcp-server-shaped tools over the same
// in-memory store as REST and GraphQL, so ids and numbers match across surfaces.

import { mergePull } from './merge.ts';
import { store, VIEWER, type IssueRec, type PullRec, type RepoRec } from './store.ts';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function stringProp(description: string): { type: string; description: string } {
  return { type: 'string', description };
}
function numberProp(description: string): { type: string; description: string } {
  return { type: 'number', description };
}
function booleanProp(description: string): { type: string; description: string } {
  return { type: 'boolean', description };
}

// Built once at module load so two tools/list calls answer byte-identical JSON.
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProp('The name of the repository to create.'),
        description: stringProp('A short description of the repository.'),
        private: booleanProp('Whether the repository is private.'),
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get the details of a repository, including its default branch and description.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        full_name: stringProp('The full name of the repository, as owner/repo.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        full_name: stringProp('The full name of the repository, as owner/repo.'),
        title: stringProp('The title of the issue.'),
        body: stringProp('The body text of the issue.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        full_name: stringProp('The full name of the repository, as owner/repo.'),
        state: stringProp('Filter by issue state: open or closed.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        full_name: stringProp('The full name of the repository, as owner/repo.'),
        issue_number: numberProp('The number of the issue.'),
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'close_issue',
    description: 'Close an open issue by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        full_name: stringProp('The full name of the repository, as owner/repo.'),
        issue_number: numberProp('The number of the issue.'),
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        full_name: stringProp('The full name of the repository, as owner/repo.'),
        title: stringProp('The title of the pull request.'),
        body: stringProp('The body text of the pull request.'),
        head: stringProp('The name of the branch to merge from.'),
        base: stringProp('The name of the branch to merge into.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The owner of the repository.'),
        repo: stringProp('The name of the repository.'),
        full_name: stringProp('The full name of the repository, as owner/repo.'),
        pull_number: numberProp('The number of the pull request to merge.'),
        merge_method: stringProp('The merge method to use: merge, squash or rebase.'),
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function repoView(repo: RepoRec): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id },
    description: repo.description,
    private: repo.isPrivate,
    default_branch: repo.defaultBranch,
  };
}

function issueView(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: VIEWER.login },
    repository: `${repo.owner}/${repo.name}`,
  };
}

function pullView(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    head: { ref: pull.headRef },
    base: { ref: pull.baseRef },
    user: { login: VIEWER.login },
    repository: `${repo.owner}/${repo.name}`,
  };
}

interface ToolOutcome {
  isError: boolean;
  value: unknown;
}

function toolError(message: string): ToolOutcome {
  return { isError: true, value: { error: message } };
}

function toolOk(value: unknown): ToolOutcome {
  return { isError: false, value };
}

/** Split a "owner/repo" full_name argument into its parts, when present. */
function fullNameParts(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const fullName = args.full_name;
  if (typeof fullName !== 'string') return null;
  const slash = fullName.indexOf('/');
  if (slash <= 0 || slash === fullName.length - 1) return null;
  return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
}

function resolveRepo(args: Record<string, unknown>): RepoRec | null {
  const parts = fullNameParts(args);
  const owner = typeof args.owner === 'string' ? args.owner : parts?.owner;
  const name = typeof args.repo === 'string' ? args.repo : parts?.repo;
  if (owner === undefined || name === undefined) return null;
  return store.repoFor(owner, name);
}

function runTool(name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (repoName === '') return toolError('a repository name is required');
      if (store.repoFor(VIEWER.login, repoName) !== null) return toolError(`repository ${repoName} already exists`);
      const repo = store.createRepo(VIEWER.login, repoName, {
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
      });
      return toolOk(repoView(repo));
    }
    case 'get_repo': {
      const repo = resolveRepo(args);
      return repo === null ? toolError('repository not found') : toolOk(repoView(repo));
    }
    case 'create_issue': {
      const repo = resolveRepo(args);
      if (repo === null) return toolError('repository not found');
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') return toolError('an issue title is required');
      const issue = store.createIssue(repo, { title, body: typeof args.body === 'string' ? args.body : '' });
      return toolOk(issueView(repo, issue));
    }
    case 'list_issues': {
      const repo = resolveRepo(args);
      if (repo === null) return toolError('repository not found');
      let list = [...repo.issues.values()].sort((a, b) => a.number - b.number);
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : '';
      if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
      return toolOk(list.map((issue) => issueView(repo, issue)));
    }
    case 'get_issue': {
      const repo = resolveRepo(args);
      if (repo === null) return toolError('repository not found');
      const number = typeof args.issue_number === 'number' ? args.issue_number : Number(args.issue_number);
      const issue = repo.issues.get(number);
      return issue === undefined ? toolError('issue not found') : toolOk(issueView(repo, issue));
    }
    case 'close_issue': {
      const repo = resolveRepo(args);
      if (repo === null) return toolError('repository not found');
      const number = typeof args.issue_number === 'number' ? args.issue_number : Number(args.issue_number);
      const issue = repo.issues.get(number);
      if (issue === undefined) return toolError('issue not found');
      issue.state = 'closed';
      return toolOk(issueView(repo, issue));
    }
    case 'create_pull_request': {
      const repo = resolveRepo(args);
      if (repo === null) return toolError('repository not found');
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (!repo.refs.has(`refs/heads/${head}`)) return toolError(`head branch ${head} does not exist`);
      if (!repo.refs.has(`refs/heads/${base}`)) return toolError(`base branch ${base} does not exist`);
      for (const pull of repo.pulls.values()) {
        if (pull.state === 'open' && pull.headRef === head && pull.baseRef === base) return toolOk(pullView(repo, pull));
      }
      const pull = store.createPull(repo, {
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
        headRef: head,
        baseRef: base,
      });
      return toolOk(pullView(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(args);
      if (repo === null) return toolError('repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolError('pull request not found');
      if (pull.state === 'open' && !pull.merged) {
        const result = mergePull(repo, pull);
        if (result === null) return toolError('pull request has conflicts and cannot be merged');
      }
      return toolOk(pullView(repo, pull));
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

export interface McpReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  empty?: boolean;
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpReply {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

/**
 * Handle one POST /mcp. `rawBody` is the unparsed request text so a non-JSON body
 * can be answered with the JSON-RPC parse error (-32700) at HTTP 400, as required.
 */
export function handleMcp(rawBody: string): McpReply {
  let message: unknown;
  try {
    message = JSON.parse(rawBody);
  } catch {
    return rpcError(null, -32700, 'Parse error: the request body is not valid JSON', 400);
  }
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object');
  }
  const request = message as { id?: unknown; method?: unknown; params?: unknown };
  const method = typeof request.method === 'string' ? request.method : '';
  const isNotification = request.id === undefined || request.id === null;

  if (method === 'server/discover') {
    return rpcResult(request.id, {
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: 'A GitHub-compatible forge: repositories, issues and pull requests over one store.',
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
  }
  if (method === 'initialize') {
    const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as {
      protocolVersion?: unknown;
    };
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const supported = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id: request.id ?? null,
        result: {
          protocolVersion: supported.includes(requested) ? requested : '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        },
      },
      headers: { 'Mcp-Session-Id': 'github-core-clone-session' },
    };
  }
  if (method.startsWith('notifications/')) {
    return { status: 202, body: null, empty: true };
  }
  if (method === 'ping') return rpcResult(request.id, {});
  if (method === 'tools/list') return rpcResult(request.id, { tools: TOOLS });
  if (method === 'tools/call') {
    const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as {
      name?: unknown;
      arguments?: unknown;
    };
    const toolName = typeof params.name === 'string' ? params.name : '';
    const tool = TOOL_BY_NAME.get(toolName);
    if (tool === undefined) return rpcError(request.id, -32602, `Unknown tool: ${toolName}`);
    const args = (typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments)
      ? params.arguments
      : {}) as Record<string, unknown>;
    const missing = tool.inputSchema.required.filter((key) => {
      if (args[key] !== undefined && args[key] !== null && args[key] !== '') return false;
      // owner/repo may arrive combined as full_name.
      if ((key === 'owner' || key === 'repo') && typeof args.full_name === 'string') return false;
      return true;
    });
    if (missing.length > 0) {
      return rpcResult(request.id, {
        content: [{ type: 'text', text: `Missing required arguments: ${missing.join(', ')}` }],
        isError: true,
      });
    }
    const outcome = runTool(toolName, args);
    const text = JSON.stringify(outcome.value);
    return rpcResult(request.id, {
      content: [{ type: 'text', text }],
      structuredContent: outcome.value,
      isError: outcome.isError,
    });
  }
  if (isNotification) return { status: 202, body: null, empty: true };
  return rpcError(request.id, -32601, `Method not found: ${method}`);
}
