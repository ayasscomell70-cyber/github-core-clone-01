// GraphQL v4: a small parser and executor for exactly the documents gh and
// github-mcp-server send (see program/env/src/checks-graphql.ts): viewer/repository/
// node reads, issue and pull-request connections with cursors, the five mutations,
// __type introspection, and batched operation arrays. Unknown fields answer HTTP 200
// with an `errors` array naming the field; an unknown repository is data.repository
// null with no errors; no token is a 401 (handled by app.ts).

import { diffFiles, flattenTree, mergeBase, parseCommit, repoLookup } from './gitcore.ts';
import { mergeableOf, squashMerge } from './rest.ts';
import {
  decodeGlobalId,
  encodeGlobalId,
  store,
  VIEWER,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// introspection tables (the fields gh feature-detects)
// -------------------------------------------------------------------------------------------

const ISSUE_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author',
  'labels', 'comments', 'url', 'repository', 'closed', 'locked', 'viewerCanUpdate',
];
const PULL_REQUEST_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRefOid',
  'baseRefOid', 'mergeable', 'merged', 'mergedAt', 'files', 'author', 'createdAt',
  'updatedAt', 'url', 'repository', 'closed', 'viewerCanUpdate',
];
const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef',
  'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests',
  'pullRequest', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt',
  'homepageUrl', 'forkCount', 'stargazerCount', 'watchers', 'primaryLanguage',
  'licenseInfo', 'mentionableUsers', 'assignableUsers',
];
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'WIKI'];

// -------------------------------------------------------------------------------------------
// lexer
// -------------------------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
  value: string;
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && src.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (src[j] === '-') j += 1;
      let isFloat = false;
      while (j < src.length && /[0-9.]/.test(src[j]!)) {
        if (src[j] === '.') isFloat = true;
        j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// -------------------------------------------------------------------------------------------
// parser
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Record<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Record<string, ValueNode>;
  selections?: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition?: string;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  kind: 'query' | 'mutation';
  name?: string;
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document, got ${JSON.stringify(token.value)}`);
    }
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek() !== undefined) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  parseOperation(): OperationNode {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '{') {
      return { kind: 'query', selections: this.parseSelectionSet() };
    }
    const keyword = this.next();
    if (keyword.kind !== 'name' || (keyword.value !== 'query' && keyword.value !== 'mutation')) {
      throw new Error(`expected query or mutation, got ${JSON.stringify(keyword.value)}`);
    }
    const kind = keyword.value as 'query' | 'mutation';
    let name: string | undefined;
    const maybeName = this.peek();
    if (maybeName?.kind === 'name') {
      name = this.next().value;
    }
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') this.skipVariableDefinitions();
    return { kind, name, selections: this.parseSelectionSet() };
  }

  /** Skip ($name: Type, ...) without interpreting the types. */
  skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      else if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      selections.push(this.parseSelection());
    }
  }

  parseSelection(): SelectionNode {
    const token = this.peek();
    if (token?.kind === 'spread') {
      this.next();
      let typeCondition: string | undefined;
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.next().value;
      }
      return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
    }
    const first = this.next();
    if (first.kind !== 'name') throw new Error(`expected a field name, got ${JSON.stringify(first.value)}`);
    let alias: string | undefined;
    let name = first.value;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args: Record<string, ValueNode> = {};
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') {
      this.next();
      for (;;) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === ')') {
          this.next();
          break;
        }
        const argName = this.next().value;
        this.expectPunct(':');
        args[argName] = this.parseValue();
      }
    }
    // Directives (@...) are ignored: the suite sends none.
    while (this.peek()?.kind === 'punct' && this.peek()!.value === '@') {
      this.next();
      this.next();
      if (this.peek()?.kind === 'punct' && this.peek()!.value === '(') this.skipVariableDefinitions();
    }
    let selections: SelectionNode[] | undefined;
    if (this.peek()?.kind === 'punct' && this.peek()!.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selections };
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.next().value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      for (;;) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === ']') {
          this.next();
          return { kind: 'list', values };
        }
        values.push(this.parseValue());
      }
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, ValueNode> = {};
      for (;;) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === '}') {
          this.next();
          return { kind: 'object', fields };
        }
        const fieldName = this.next().value;
        this.expectPunct(':');
        fields[fieldName] = this.parseValue();
      }
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: parseFloat(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token.value)}`);
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((value) => evalValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.fields)) out[key] = evalValue(value, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------------------
// views (objects the resolvers hand back, each carrying its GraphQL type)
// -------------------------------------------------------------------------------------------

type View = Record<string, unknown> & { __typename: string };

function userView(): View {
  return { __typename: 'User', _login: VIEWER.login };
}

function repoView(repo: Repo): View {
  return { __typename: 'Repository', _repo: repo };
}

function issueView(repo: Repo, issue: Issue): View {
  return { __typename: 'Issue', _repo: repo, _issue: issue };
}

function pullView(repo: Repo, pull: Pull): View {
  return { __typename: 'PullRequest', _repo: repo, _pull: pull };
}

function commentView(repo: Repo, issue: Issue, comment: Issue['comments'][number]): View {
  return { __typename: 'IssueComment', _repo: repo, _issue: issue, _comment: comment };
}

function refView(repo: Repo, name: string): View {
  return { __typename: 'Ref', _repo: repo, _name: name };
}

function typeView(name: string): View {
  return { __typename: '__Type', _name: name };
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? parseInt(match[1]!, 10) : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// connections
// -------------------------------------------------------------------------------------------

function issueConnection(repo: Repo, args: Record<string, unknown>): View {
  let issues = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    issues = issues.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  } else {
    issues = issues.filter((issue) => issue.state === 'open');
  }
  const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
  if (orderBy?.field === 'CREATED_AT') {
    issues.sort((a, b) => (orderBy.direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
  } else {
    issues.sort((a, b) => a.seq - b.seq);
  }
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  let start = 0;
  if (after !== null) {
    const index = issues.findIndex((issue) => issue.number === after);
    if (index >= 0) start = index + 1;
  }
  const slice = issues.slice(start, start + first);
  const hasNextPage = start + slice.length < issues.length;
  return {
    __typename: 'IssueConnection',
    nodes: slice.map((issue) => issueView(repo, issue)),
    totalCount: issues.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? encodeCursor(slice[0]!.number) : null,
      endCursor: slice.length > 0 ? encodeCursor(slice[slice.length - 1]!.number) : null,
    },
  };
}

function pullConnection(repo: Repo, args: Record<string, unknown>): View {
  let pulls = [...repo.pulls.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    pulls = pulls.filter((pull) => states.includes(pull.state === 'open' ? 'OPEN' : 'CLOSED'));
  } else {
    pulls = pulls.filter((pull) => pull.state === 'open');
  }
  pulls.sort((a, b) => b.seq - a.seq);
  const first = typeof args.first === 'number' ? args.first : pulls.length;
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  let start = 0;
  if (after !== null) {
    const index = pulls.findIndex((pull) => pull.number === after);
    if (index >= 0) start = index + 1;
  }
  const slice = pulls.slice(start, start + first);
  const hasNextPage = start + slice.length < pulls.length;
  return {
    __typename: 'PullRequestConnection',
    nodes: slice.map((pull) => pullView(repo, pull)),
    totalCount: pulls.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: slice.length > 0 ? encodeCursor(slice[0]!.number) : null,
      endCursor: slice.length > 0 ? encodeCursor(slice[slice.length - 1]!.number) : null,
    },
  };
}

function pullFilesConnection(repo: Repo, pull: Pull, args: Record<string, unknown>): View {
  const lookup = repoLookup(repo);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  let nodes: View[] = [];
  if (headTip && baseTip) {
    const base = mergeBase(lookup, headTip, baseTip) ?? baseTip;
    const baseTree = parseCommit(repo.objects.get(base)!.data).tree;
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const files = diffFiles(lookup, baseTree, headTree);
    const first = typeof args.first === 'number' ? args.first : files.length;
    nodes = files.slice(0, first).map((file) => ({
      __typename: 'PullRequestFile',
      path: file.filename,
      additions: file.additions,
      deletions: file.deletions,
      changeType: file.status.toUpperCase(),
    }));
  }
  return {
    __typename: 'PullRequestFileConnection',
    nodes,
    totalCount: nodes.length,
    pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
  };
}

// -------------------------------------------------------------------------------------------
// node resolution (Relay global ids)
// -------------------------------------------------------------------------------------------

function nodeById(id: string): View | null {
  const decoded = decodeGlobalId(id);
  if (!decoded) return null;
  const [owner, name, numberText, extra] = decoded.parts;
  if (owner === undefined || name === undefined) return null;
  const repo = owner === VIEWER.login ? store.getRepo(owner, name) : undefined;
  if (!repo) return null;
  if (decoded.kind === 'R') return repoView(repo);
  const number = numberText === undefined ? NaN : parseInt(numberText, 10);
  if (!Number.isInteger(number)) return null;
  if (decoded.kind === 'I') {
    const issue = repo.issues.get(number);
    return issue ? issueView(repo, issue) : null;
  }
  if (decoded.kind === 'P') {
    const pull = repo.pulls.get(number);
    return pull ? pullView(repo, pull) : null;
  }
  if (decoded.kind === 'C') {
    const issue = repo.issues.get(number);
    const commentId = extra === undefined ? NaN : parseInt(extra, 10);
    const comment = issue?.comments.find((entry) => entry.id === commentId);
    return issue && comment ? commentView(repo, issue, comment) : null;
  }
  return null;
}

// -------------------------------------------------------------------------------------------
// field resolution
// -------------------------------------------------------------------------------------------

function fieldNamesOf(typeName: string): string[] {
  switch (typeName) {
    case 'Issue':
      return ISSUE_FIELDS;
    case 'PullRequest':
      return PULL_REQUEST_FIELDS;
    case 'Repository':
      return REPOSITORY_FIELDS;
    case 'Query':
      return ['viewer', 'repository', 'node'];
    case 'Mutation':
      return ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'];
    case 'User':
      return ['login', 'id', 'name', 'email'];
    case 'Ref':
      return ['name', 'target'];
    case 'Commit':
      return ['oid', 'message'];
    case 'Label':
      return ['name', 'color', 'description'];
    case 'IssueComment':
      return ['id', 'body', 'author', 'createdAt'];
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection':
    case 'LabelConnection':
    case 'IssueCommentConnection':
      return ['nodes', 'edges', 'totalCount', 'pageInfo'];
    case 'PageInfo':
      return ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'];
    case 'Edge':
    case 'IssueCommentEdge':
      return ['node', 'cursor'];
    case 'PullRequestFile':
      return ['path', 'additions', 'deletions', 'changeType'];
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      return ['issue', 'clientMutationId'];
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      return ['pullRequest', 'clientMutationId'];
    case 'AddCommentPayload':
      return ['commentEdge', 'clientMutationId'];
    default:
      return [];
  }
}

/**
 * Resolve one field of a view. Returns {value} or {error} when the field does not
 * exist on the type (the executor turns that into an errors entry and a null).
 */
function resolveField(
  view: View,
  field: FieldNode,
  args: Record<string, unknown>,
  errors: Array<{ message: string }>,
): unknown {
  const typeName = view.__typename;
  const name = field.name;
  if (name === '__typename') return typeName;

  switch (typeName) {
    case 'Query': {
      if (name === 'viewer') return userView();
      if (name === 'repository') {
        const owner = args.owner as string | undefined;
        const repoName = args.name as string | undefined;
        if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
        const repo = owner === VIEWER.login ? store.getRepo(owner, repoName) : undefined;
        return repo ? repoView(repo) : null;
      }
      if (name === 'node') {
        const id = args.id as string | undefined;
        return typeof id === 'string' ? nodeById(id) : null;
      }
      if (name === '__type') {
        const typeArg = args.name as string | undefined;
        return typeof typeArg === 'string' ? typeView(typeArg) : null;
      }
      break;
    }
    case 'Mutation': {
      return resolveMutation(view, field, args, errors);
    }
    case 'User': {
      if (name === 'login') return view._login;
      if (name === 'id') return encodeGlobalId('U', String(view._login));
      if (name === 'name') return VIEWER.name;
      if (name === 'email') return VIEWER.email;
      break;
    }
    case 'Repository': {
      const repo = view._repo as Repo;
      if (name === 'id') return encodeGlobalId('R', repo.owner, repo.name);
      if (name === 'databaseId') return repo.id;
      if (name === 'name') return repo.name;
      if (name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (name === 'owner') return userView();
      if (name === 'defaultBranchRef') {
        return repo.refs.has(`refs/heads/${repo.defaultBranch}`) ? refView(repo, repo.defaultBranch) : null;
      }
      if (name === 'viewerPermission') return 'ADMIN';
      if (name === 'hasIssuesEnabled') return true;
      if (name === 'description') return repo.description;
      if (name === 'isPrivate') return repo.private;
      if (name === 'url') return `/${repo.owner}/${repo.name}`;
      if (name === 'createdAt' || name === 'updatedAt') return repo.createdAt;
      if (name === 'issue') {
        const number = args.number as number | undefined;
        const issue = typeof number === 'number' ? repo.issues.get(number) : undefined;
        return issue ? issueView(repo, issue) : null;
      }
      if (name === 'issues') return issueConnection(repo, args);
      if (name === 'pullRequests') return pullConnection(repo, args);
      if (name === 'pullRequest') {
        const number = args.number as number | undefined;
        const pull = typeof number === 'number' ? repo.pulls.get(number) : undefined;
        return pull ? pullView(repo, pull) : null;
      }
      break;
    }
    case 'Issue': {
      const repo = view._repo as Repo;
      const issue = view._issue as Issue;
      if (name === 'id') return encodeGlobalId('I', repo.owner, repo.name, issue.number);
      if (name === 'number') return issue.number;
      if (name === 'title') return issue.title;
      if (name === 'body') return issue.body;
      if (name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (name === 'createdAt') return issue.createdAt;
      if (name === 'updatedAt') return issue.updatedAt;
      if (name === 'author') return userView();
      if (name === 'url') return `/${repo.owner}/${repo.name}/issues/${issue.number}`;
      if (name === 'repository') return repoView(repo);
      if (name === 'closed') return issue.state === 'closed';
      if (name === 'locked') return false;
      if (name === 'viewerCanUpdate') return true;
      if (name === 'labels') {
        return {
          __typename: 'LabelConnection',
          nodes: issue.labels.map((label) => ({ __typename: 'Label', name: label.name, color: label.color, description: '' })),
          totalCount: issue.labels.length,
          pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        };
      }
      if (name === 'comments') {
        return {
          __typename: 'IssueCommentConnection',
          nodes: issue.comments.map((comment) => commentView(repo, issue, comment)),
          totalCount: issue.comments.length,
          pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        };
      }
      break;
    }
    case 'PullRequest': {
      const repo = view._repo as Repo;
      const pull = view._pull as Pull;
      if (name === 'id') return encodeGlobalId('P', repo.owner, repo.name, pull.number);
      if (name === 'number') return pull.number;
      if (name === 'title') return pull.title;
      if (name === 'body') return pull.body;
      if (name === 'state') return pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (name === 'headRefName') return pull.head;
      if (name === 'baseRefName') return pull.base;
      if (name === 'headRefOid') return repo.refs.get(`refs/heads/${pull.head}`) ?? null;
      if (name === 'baseRefOid') return repo.refs.get(`refs/heads/${pull.base}`) ?? null;
      if (name === 'mergeable') return mergeableOf(repo, pull);
      if (name === 'merged') return pull.merged;
      if (name === 'mergedAt') return pull.mergedAt;
      if (name === 'createdAt') return pull.createdAt;
      if (name === 'updatedAt') return pull.updatedAt;
      if (name === 'author') return userView();
      if (name === 'url') return `/${repo.owner}/${repo.name}/pull/${pull.number}`;
      if (name === 'repository') return repoView(repo);
      if (name === 'closed') return pull.state === 'closed';
      if (name === 'viewerCanUpdate') return true;
      if (name === 'files') return pullFilesConnection(repo, pull, args);
      break;
    }
    case 'Ref': {
      const repo = view._repo as Repo;
      const refName = view._name as string;
      if (name === 'name') return refName;
      if (name === 'target') {
        const oid = repo.refs.get(`refs/heads/${refName}`);
        return oid ? { __typename: 'Commit', oid, message: '' } : null;
      }
      break;
    }
    case 'Commit': {
      if (name === 'oid') return view.oid;
      if (name === 'message') return view.message;
      break;
    }
    case 'Label': {
      if (name === 'name') return view.name;
      if (name === 'color') return view.color;
      if (name === 'description') return view.description;
      break;
    }
    case 'IssueComment': {
      const repo = view._repo as Repo;
      const issue = view._issue as Issue;
      const comment = view._comment as Issue['comments'][number];
      if (name === 'id') return encodeGlobalId('C', repo.owner, repo.name, issue.number, comment.id);
      if (name === 'body') return comment.body;
      if (name === 'author') return userView();
      if (name === 'createdAt') return comment.createdAt;
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection':
    case 'LabelConnection':
    case 'IssueCommentConnection': {
      if (name === 'nodes') return view.nodes;
      if (name === 'edges') {
        const nodes = view.nodes as View[];
        return nodes.map((node) => ({ __typename: 'Edge', node, cursor: null }));
      }
      if (name === 'totalCount') return view.totalCount;
      if (name === 'pageInfo') return view.pageInfo;
      break;
    }
    case 'PageInfo': {
      if (name === 'hasNextPage') return view.hasNextPage;
      if (name === 'hasPreviousPage') return view.hasPreviousPage;
      if (name === 'startCursor') return view.startCursor;
      if (name === 'endCursor') return view.endCursor;
      break;
    }
    case 'Edge':
    case 'IssueCommentEdge': {
      if (name === 'node') return view.node;
      if (name === 'cursor') return view.cursor ?? null;
      break;
    }
    case 'PullRequestFile': {
      if (name === 'path') return view.path;
      if (name === 'additions') return view.additions;
      if (name === 'deletions') return view.deletions;
      if (name === 'changeType') return view.changeType;
      break;
    }
    case '__Type': {
      const typeNameArg = view._name as string;
      if (name === 'name') return typeNameArg;
      if (name === 'kind') return typeNameArg === 'SearchType' ? 'ENUM' : 'OBJECT';
      if (name === 'fields') {
        const fields = fieldNamesOf(typeNameArg);
        return fields.length > 0
          ? fields.map((fieldName) => ({ __typename: '__Field', name: fieldName }))
          : null;
      }
      if (name === 'enumValues') {
        return typeNameArg === 'SearchType'
          ? SEARCH_TYPE_VALUES.map((value) => ({ __typename: '__EnumValue', name: value }))
          : null;
      }
      break;
    }
    case '__Field': {
      if (name === 'name') return view.name;
      break;
    }
    case '__EnumValue': {
      if (name === 'name') return view.name;
      break;
    }
  }
  errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
  return null;
}

// -------------------------------------------------------------------------------------------
// mutations
// -------------------------------------------------------------------------------------------

function decodeRepoId(id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'R') return null;
  const [owner, name] = decoded.parts;
  if (owner === undefined || name === undefined) return null;
  return owner === VIEWER.login ? (store.getRepo(owner, name) ?? null) : null;
}

function decodeIssueId(id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'I') return null;
  const [owner, name, numberText] = decoded.parts;
  if (owner === undefined || name === undefined || numberText === undefined) return null;
  const repo = owner === VIEWER.login ? store.getRepo(owner, name) : undefined;
  if (!repo) return null;
  const issue = repo.issues.get(parseInt(numberText, 10));
  return issue ? { repo, issue } : null;
}

function decodePullId(id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'P') return null;
  const [owner, name, numberText] = decoded.parts;
  if (owner === undefined || name === undefined || numberText === undefined) return null;
  const repo = owner === VIEWER.login ? store.getRepo(owner, name) : undefined;
  if (!repo) return null;
  const pull = repo.pulls.get(parseInt(numberText, 10));
  return pull ? { repo, pull } : null;
}

function resolveMutation(
  _view: View,
  field: FieldNode,
  args: Record<string, unknown>,
  errors: Array<{ message: string }>,
): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  switch (field.name) {
    case 'createIssue': {
      const repo = decodeRepoId(input.repositoryId);
      if (!repo) {
        errors.push({ message: 'createIssue: the repository does not exist' });
        return null;
      }
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      const issue = store.createIssue(repo, title, body, []);
      return { __typename: 'CreateIssuePayload', _repo: repo, _issue: issue };
    }
    case 'closeIssue': {
      const found = decodeIssueId(input.issueId);
      if (!found) {
        errors.push({ message: 'closeIssue: the issue does not exist' });
        return null;
      }
      found.issue.state = 'closed';
      return { __typename: 'CloseIssuePayload', _repo: found.repo, _issue: found.issue };
    }
    case 'createPullRequest': {
      const repo = decodeRepoId(input.repositoryId);
      if (!repo) {
        errors.push({ message: 'createPullRequest: the repository does not exist' });
        return null;
      }
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const title = typeof input.title === 'string' ? input.title : '';
      const body = typeof input.body === 'string' ? input.body : '';
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        errors.push({ message: 'createPullRequest: head or base branch does not exist' });
        return null;
      }
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.head === head && existing.base === base) {
          errors.push({ message: 'createPullRequest: a pull request already exists for this head and base' });
          return null;
        }
      }
      const pull = store.createPull(repo, title, body, head, base);
      return { __typename: 'CreatePullRequestPayload', _repo: repo, _pull: pull };
    }
    case 'mergePullRequest': {
      const found = decodePullId(input.pullRequestId);
      if (!found) {
        errors.push({ message: 'mergePullRequest: the pull request does not exist' });
        return null;
      }
      if (found.pull.merged || found.pull.state === 'closed') {
        errors.push({ message: 'mergePullRequest: the pull request is already closed' });
        return null;
      }
      const mergeSha = squashMerge(found.repo, found.pull);
      if (mergeSha === null) {
        errors.push({ message: 'mergePullRequest: merge conflict' });
        return null;
      }
      return { __typename: 'MergePullRequestPayload', _repo: found.repo, _pull: found.pull };
    }
    case 'addComment': {
      const found = decodeIssueId(input.subjectId);
      if (!found) {
        errors.push({ message: 'addComment: the subject does not exist' });
        return null;
      }
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = {
        id: store.nextEntityId(),
        body,
        userLogin: VIEWER.login,
        createdAt: '',
      };
      comment.createdAt = found.issue.createdAt;
      found.issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        _repo: found.repo,
        _issue: found.issue,
        _comment: comment,
      };
    }
    default: {
      errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
      return null;
    }
  }
}

// Payload fields: createIssue.issue, closeIssue.issue, createPullRequest.pullRequest,
// mergePullRequest.pullRequest, addComment.commentEdge.node.
function resolvePayloadField(view: View, field: FieldNode): unknown {
  switch (field.name) {
    case 'issue':
      return view._issue ? issueView(view._repo as Repo, view._issue as Issue) : null;
    case 'pullRequest':
      return view._pull ? pullView(view._repo as Repo, view._pull as Pull) : null;
    case 'commentEdge':
      if (!view._comment) return null;
      return {
        __typename: 'IssueCommentEdge',
        node: commentView(view._repo as Repo, view._issue as Issue, view._comment as Issue['comments'][number]),
        cursor: null,
      };
    case 'clientMutationId':
      return null;
    default:
      return null;
  }
}

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

function executeSelectionSet(
  view: View,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  errors: Array<{ message: string }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== view.__typename) continue;
      Object.assign(out, executeSelectionSet(view, selection.selections, variables, errors));
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const [key, node] of Object.entries(selection.args)) args[key] = evalValue(node, variables);
    let value: unknown;
    if (
      view.__typename === 'CreateIssuePayload' ||
      view.__typename === 'CloseIssuePayload' ||
      view.__typename === 'CreatePullRequestPayload' ||
      view.__typename === 'MergePullRequestPayload' ||
      view.__typename === 'AddCommentPayload'
    ) {
      value = resolvePayloadField(view, selection);
    } else {
      value = resolveField(view, selection, args, errors);
    }
    const key = selection.alias ?? selection.name;
    if (value === null || value === undefined) {
      out[key] = null;
    } else if (Array.isArray(value)) {
      out[key] = value.map((entry) =>
        typeof entry === 'object' && entry !== null && '__typename' in entry && selection.selections
          ? executeSelectionSet(entry as View, selection.selections, variables, errors)
          : entry,
      );
    } else if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      out[key] = selection.selections
        ? executeSelectionSet(value as View, selection.selections, variables, errors)
        : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function executeOne(body: Record<string, unknown>): Record<string, unknown> {
  const query = body.query;
  if (typeof query !== 'string') {
    return { errors: [{ message: 'GraphQL request needs a query string' }] };
  }
  const variables = (body.variables ?? {}) as Record<string, unknown>;
  let operations: OperationNode[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
  }
  const operation = operations[0];
  if (!operation) {
    return { errors: [{ message: 'GraphQL document holds no operation' }] };
  }
  const errors: Array<{ message: string }> = [];
  const root: View = { __typename: operation.kind === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelectionSet(root, operation.selections, variables, errors);
  return errors.length > 0 ? { data, errors } : { data };
}

/**
 * Execute one GraphQL request body (a single operation object, or an array of them
 * for GitHub's operation batching). Returns the response body.
 */
export function executeGraphQL(body: unknown): unknown {
  if (Array.isArray(body)) return body.map((entry) => (typeof entry === 'object' && entry !== null ? executeOne(entry as Record<string, unknown>) : { errors: [{ message: 'bad operation' }] }));
  if (typeof body === 'object' && body !== null) return executeOne(body as Record<string, unknown>);
  return { errors: [{ message: 'GraphQL request needs a JSON object body' }] };
}
