// Model Context Protocol over Streamable HTTP at /mcp: JSON-RPC 2.0, the modern
// 2026-07-28 era (server/discover, no handshake, no session) with the legacy
// initialize handshake as a fallback. Tools share the store with REST, so a repo or
// issue created over MCP reads back over /api/v3 as the same object.

import { squashMerge } from './rest.ts';
import { store, VIEWER, type Repo } from './store.ts';

// -------------------------------------------------------------------------------------------
// tools (one fixed list: two tools/list calls answer byte-identical JSON)
// -------------------------------------------------------------------------------------------

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const SERVER_INFO = { name: 'forge', version: '1.0.0' };

// -------------------------------------------------------------------------------------------
// tool results
// -------------------------------------------------------------------------------------------

type ToolOutcome =
  | { ok: true; payload: unknown }
  | { ok: false; message: string };

function repoPayload(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function findRepo(args: Record<string, unknown>): Repo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repo = typeof args.repo === 'string' ? args.repo : '';
  if (owner === '' || repo === '') return null;
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, repo) ?? null;
}

function runTool(name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (repoName === '') return { ok: false, message: 'Missing required argument: name' };
      if (store.getRepo(VIEWER.login, repoName) !== undefined) {
        return { ok: false, message: `Repository ${VIEWER.login}/${repoName} already exists` };
      }
      const repo = store.createRepo(
        VIEWER.login,
        repoName,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      return { ok: true, payload: repoPayload(repo) };
    }
    case 'get_repo': {
      const repo = findRepo(args);
      if (!repo) return { ok: false, message: 'Repository not found' };
      return { ok: true, payload: repoPayload(repo) };
    }
    case 'create_issue': {
      const repo = findRepo(args);
      if (!repo) return { ok: false, message: 'Repository not found' };
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') return { ok: false, message: 'Missing required argument: title' };
      const issue = store.createIssue(repo, title, typeof args.body === 'string' ? args.body : '', []);
      return {
        ok: true,
        payload: {
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          full_name: `${repo.owner}/${repo.name}`,
        },
      };
    }
    case 'list_issues': {
      const repo = findRepo(args);
      if (!repo) return { ok: false, message: 'Repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => a.seq - b.seq);
      return {
        ok: true,
        payload: issues.map((issue) => ({
          id: issue.id,
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
        })),
      };
    }
    case 'create_pull_request': {
      const repo = findRepo(args);
      if (!repo) return { ok: false, message: 'Repository not found' };
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (title === '' || head === '' || base === '') {
        return { ok: false, message: 'Missing required argument: title, head or base' };
      }
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        return { ok: false, message: 'head or base branch does not exist' };
      }
      const pull = store.createPull(repo, title, typeof args.body === 'string' ? args.body : '', head, base);
      return {
        ok: true,
        payload: {
          id: pull.id,
          number: pull.number,
          title: pull.title,
          body: pull.body,
          state: pull.state,
          head: { ref: head },
          base: { ref: base },
          full_name: `${repo.owner}/${repo.name}`,
        },
      };
    }
    case 'merge_pull_request': {
      const repo = findRepo(args);
      if (!repo) return { ok: false, message: 'Repository not found' };
      const number = typeof args.pull_number === 'number' ? args.pull_number : NaN;
      const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
      if (!pull) return { ok: false, message: 'Pull request not found' };
      if (pull.merged || pull.state === 'closed') return { ok: false, message: 'Pull request is already closed' };
      const merged = squashMerge(repo, pull);
      if (merged === null) return { ok: false, message: 'Merge conflict' };
      return {
        ok: true,
        payload: { number: pull.number, merged: true, state: pull.state, sha: merged },
      };
    }
    default:
      return { ok: false, message: `Unknown tool: ${name}` };
  }
}

// -------------------------------------------------------------------------------------------
// JSON-RPC
// -------------------------------------------------------------------------------------------

export interface McpOutcome {
  status: number;
  /** The JSON body to send (null for a 202 notification answer with no body). */
  body: unknown | null;
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function toolResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

const LEGACY_REVISIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** Handle one parsed JSON-RPC request body (already authenticated by app.ts). */
export function handleMcp(body: unknown): McpOutcome {
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => handleOne(entry).body) };
  }
  return handleOne(body);
}

function handleOne(body: unknown): McpOutcome {
  if (typeof body !== 'object' || body === null) {
    return { status: 400, body: rpcError(null, -32700, 'Parse error') };
  }
  const request = body as Record<string, unknown>;
  const id = request.id;
  const method = request.method;
  const params = (request.params ?? {}) as Record<string, unknown>;

  // A notification (no id) is answered 202 with no body.
  if (id === undefined) {
    return { status: 202, body: null };
  }
  if (typeof method !== 'string') {
    return { status: 200, body: rpcError(id, -32600, 'Invalid Request') };
  }

  switch (method) {
    case 'server/discover': {
      return {
        status: 200,
        body: rpcResult(id, {
          supportedVersions: ['2026-07-28'],
          capabilities: { tools: {} },
          serverInfo: { ...SERVER_INFO },
          _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
        }),
      };
    }
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const negotiated = LEGACY_REVISIONS.includes(requested) ? requested : '2025-11-25';
      return {
        status: 200,
        body: rpcResult(id, {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { ...SERVER_INFO },
        }),
      };
    }
    case 'ping': {
      return { status: 200, body: rpcResult(id, {}) };
    }
    case 'tools/list': {
      return { status: 200, body: rpcResult(id, { tools: MCP_TOOLS }) };
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const tool = MCP_TOOLS.find((entry) => entry.name === name);
      if (!tool) {
        return { status: 200, body: rpcError(id, -32602, `Unknown tool: ${name}`) };
      }
      const missing = tool.inputSchema.required.filter((field) => args[field] === undefined || args[field] === null || args[field] === '');
      if (missing.length > 0) {
        return { status: 200, body: rpcResult(id, toolError(`Missing required argument(s): ${missing.join(', ')}`)) };
      }
      const outcome = runTool(name, args);
      if (!outcome.ok) {
        return { status: 200, body: rpcResult(id, toolError(outcome.message)) };
      }
      return { status: 200, body: rpcResult(id, toolResult(outcome.payload)) };
    }
    default: {
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`) };
    }
  }
}
