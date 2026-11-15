// GitHub REST v3: repositories, issues, pull requests, contents, labels, merge.
// Every reply is application/json with X-GitHub-Request-Id (app.ts sets the header);
// unknown routes are JSON 404s; a malformed JSON body is a 400; no token is a 401;
// the same repository name under another owner is a 404, never a 403.

import {
  buildCommit,
  buildTreeFromFiles,
  diffFiles,
  flattenTree,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTree,
  repoLookup,
  threeWayMerge,
  treeEntryAtPath,
} from './gitcore.ts';
import { linkBase, pageParams, paginate, sendError, sendJson, sendNoContent, type Ctx } from './httputil.ts';
import {
  nextCommitTimestamp,
  nextIsoTime,
  store,
  VIEWER,
  type Issue,
  type Label,
  type Pull,
  type Repo,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// shapes
// -------------------------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: '' };
}

export function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
    html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(comment: { id: number; body: string; userLogin: string; createdAt: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: { login: comment.userLogin, id: VIEWER.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

function authorOf(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line.trim());
  if (!match) return { name: line, email: '', date: '' };
  const ts = Number(match[3]) * 1000;
  return { name: match[1]!, email: match[2]!, date: new Date(ts).toISOString().replace('.000Z', 'Z') };
}

export function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return null;
  const parsed = parseCommit(object.data);
  return {
    sha,
    commit: {
      message: parsed.message,
      author: authorOf(parsed.author),
      committer: authorOf(parsed.committer),
      tree: { sha: parsed.tree },
    },
    author: { login: VIEWER.login, id: VIEWER.id },
    committer: { login: VIEWER.login, id: VIEWER.id },
    parents: parsed.parents.map((parent) => ({ sha: parent })),
  };
}

export function mergeableOf(repo: Repo, pull: Pull): string {
  if (pull.merged) return 'MERGEABLE';
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headTip || !baseTip) return 'UNKNOWN';
  const lookup = repoLookup(repo);
  const base = mergeBase(lookup, headTip, baseTip);
  if (base === null) return 'UNKNOWN';
  const baseTree = parseCommit(repo.objects.get(base)!.data).tree;
  const oursTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  const theirsTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const merged = threeWayMerge(flattenTree(lookup, baseTree), flattenTree(lookup, oursTree), flattenTree(lookup, theirsTree));
  return merged.conflicts.length === 0 ? 'MERGEABLE' : 'CONFLICTING';
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  return {
    id: pull.id,
    node_id: `P_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: {
      ref: pull.head,
      sha: headTip ?? '',
      label: `${repo.owner}:${pull.head}`,
      user: { login: repo.owner, id: VIEWER.id },
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    base: {
      ref: pull.base,
      sha: baseTip ?? '',
      label: `${repo.owner}:${pull.base}`,
      user: { login: repo.owner, id: VIEWER.id },
      repo: { name: repo.name, full_name: `${repo.owner}/${repo.name}` },
    },
    merged: pull.merged,
    mergeable: mergeableOf(repo, pull),
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
  };
}

// -------------------------------------------------------------------------------------------
// lookups
// -------------------------------------------------------------------------------------------

/** The repo a REST request names, or null (another owner or a missing repo is a 404). */
function restRepo(owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

function needRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  const repo = restRepo(owner, name);
  if (repo === null) sendError(ctx.res, 404, 'Not Found');
  return repo;
}

/** Resolve a branch name or a commit sha to a commit oid, or null. */
function resolveRef(repo: Repo, ref: string): string | null {
  if (isObjectId(ref)) return repo.objects.get(ref)?.type === 'commit' ? ref : null;
  const oid = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
  if (oid === undefined) return null;
  const object = repo.objects.get(oid);
  if (!object) return null;
  if (object.type === 'commit') return oid;
  return null;
}

function bodyOf(ctx: Ctx): Record<string, unknown> {
  return typeof ctx.body === 'object' && ctx.body !== null && !Array.isArray(ctx.body)
    ? (ctx.body as Record<string, unknown>)
    : {};
}

function stringField(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

// -------------------------------------------------------------------------------------------
// contents commits
// -------------------------------------------------------------------------------------------

/**
 * Commit a mutated file map on a branch: build the nested trees, write the commit
 * (author/committer are the viewer, timestamp is the logical clock), move the ref.
 */
function commitFiles(repo: Repo, branch: string, message: string, mutate: (files: Map<string, { oid: string; mode: string }>) => void): string {
  const tipOid = repo.refs.get(`refs/heads/${branch}`);
  const files = new Map<string, { oid: string; mode: string }>();
  const parents: string[] = [];
  if (tipOid !== undefined) {
    const object = repo.objects.get(tipOid);
    if (object?.type === 'commit') {
      const parsed = parseCommit(object.data);
      for (const [path, entry] of flattenTree(repoLookup(repo), parsed.tree)) files.set(path, entry);
      parents.push(tipOid);
    }
  }
  mutate(files);
  const { rootOid, trees } = buildTreeFromFiles(files);
  for (const [oid, object] of trees) repo.objects.set(oid, object);
  const author = `${VIEWER.name} <${VIEWER.email}>`;
  const data = buildCommit({
    tree: rootOid,
    parents,
    message,
    author,
    committer: author,
    timestamp: nextCommitTimestamp(),
  });
  const commitOid = hashObject('commit', data);
  repo.objects.set(commitOid, { type: 'commit', data });
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  store.touch(repo);
  return commitOid;
}

// -------------------------------------------------------------------------------------------
// the router
// -------------------------------------------------------------------------------------------

/** Route one /api/v3 request. Returns true when it answered. */
export function handleRest(ctx: Ctx, segments: string[]): boolean {
  const { res } = ctx;
  const method = ctx.req.method ?? 'GET';

  // The API root and the meta probe need no token.
  if (segments.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method === 'GET') {
      sendJson(res, 200, { installed_version: '1.0.0' });
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // Everything else needs a token.
  if (ctx.user === null) {
    sendError(res, 401, 'Requires authentication');
    return true;
  }
  if (ctx.bodyMalformed) {
    sendError(res, 400, 'Invalid JSON body');
    return true;
  }

  // POST /user/repos and GET /user/repos.
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') return createUserRepo(ctx);
    if (method === 'GET') return listUserRepos(ctx);
    sendError(res, 404, 'Not Found');
    return true;
  }

  // /repos/{owner}/{name}...
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = decodeURIComponent(segments[1]!);
    const name = decodeURIComponent(segments[2]!);
    const rest = segments.slice(3);
    if (rest.length === 0) {
      if (method === 'GET') return getRepo(ctx, owner, name);
      if (method === 'PATCH') return patchRepo(ctx, owner, name);
      if (method === 'DELETE') return deleteRepo(ctx, owner, name);
      sendError(res, 404, 'Not Found');
      return true;
    }
    if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') return listBranches(ctx, owner, name);
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') return listCommits(ctx, owner, name);
    if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2 && method === 'POST') return createRef(ctx, owner, name);
    if (rest[0] === 'contents' && rest.length >= 2) return contentsRoute(ctx, owner, name, rest.slice(1), method);
    if (rest[0] === 'labels' && rest.length === 1) {
      if (method === 'POST') return createLabel(ctx, owner, name);
      if (method === 'GET') return listLabels(ctx, owner, name);
    }
    if (rest[0] === 'issues' && rest.length === 1) {
      if (method === 'POST') return createIssue(ctx, owner, name);
      if (method === 'GET') return listIssues(ctx, owner, name);
    }
    if (rest[0] === 'issues' && rest.length === 2) {
      if (method === 'GET') return getIssue(ctx, owner, name, rest[1]!);
      if (method === 'PATCH') return patchIssue(ctx, owner, name, rest[1]!);
    }
    if (rest[0] === 'issues' && rest.length === 3 && rest[2] === 'comments') {
      if (method === 'POST') return createComment(ctx, owner, name, rest[1]!);
      if (method === 'GET') return listComments(ctx, owner, name, rest[1]!);
    }
    if (rest[0] === 'pulls' && rest.length === 1) {
      if (method === 'POST') return createPull(ctx, owner, name);
      if (method === 'GET') return listPulls(ctx, owner, name);
    }
    if (rest[0] === 'pulls' && rest.length === 2) {
      if (method === 'GET') return getPull(ctx, owner, name, rest[1]!);
    }
    if (rest[0] === 'pulls' && rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      return listPullFiles(ctx, owner, name, rest[1]!);
    }
    if (rest[0] === 'pulls' && rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      return mergePull(ctx, owner, name, rest[1]!);
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  sendError(res, 404, 'Not Found');
  return true;
}

// -------------------------------------------------------------------------------------------
// repositories
// -------------------------------------------------------------------------------------------

const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function createUserRepo(ctx: Ctx): boolean {
  const body = bodyOf(ctx);
  const name = stringField(body, 'name');
  if (!REPO_NAME_RE.test(name) || name === '.' || name === '..' || name.endsWith('.git')) {
    sendError(ctx.res, 422, 'Invalid repository name');
    return true;
  }
  if (store.getRepo(VIEWER.login, name) !== undefined) {
    sendError(ctx.res, 422, `Repository ${VIEWER.login}/${name} already exists`);
    return true;
  }
  const repo = store.createRepo(
    VIEWER.login,
    name,
    stringField(body, 'description'),
    body.private === true,
  );
  sendJson(ctx.res, 201, repoJson(repo));
  return true;
}

function listUserRepos(ctx: Ctx): boolean {
  const params = pageParams(ctx.query);
  const repos = store.reposOf(VIEWER.login);
  const { page, link } = paginate(repos, params, linkBase(ctx.req, ctx.origin));
  const headers: Record<string, string> = {};
  if (link !== null) headers.link = link;
  sendJson(ctx.res, 200, page.map(repoJson), headers);
  return true;
}

function getRepo(ctx: Ctx, owner: string, name: string): boolean {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) return true;
  sendJson(ctx.res, 200, repoJson(repo));
  return true;
}

function patchRepo(ctx: Ctx, owner: string, name: string): boolean {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) return true;
  const body = bodyOf(ctx);
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.private = body.private;
  sendJson(ctx.res, 200, repoJson(repo));
  return true;
}

function deleteRepo(ctx: Ctx, owner: string, name: string): boolean {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) return true;
  store.deleteRepo(repo.owner, repo.name);
  sendNoContent(ctx.res);
  return true;
}

function listBranches(ctx: Ctx, owner: string, name: string): boolean {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) return true;
  const branches: Array<Record<string, unknown>> = [];
  for (const [ref, oid] of [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
  }
  sendJson(ctx.res, 200, branches);
  return true;
}

function listCommits(ctx: Ctx, owner: string, name: string): boolean {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) return true;
  const ref = ctx.query.get('sha') ?? repo.defaultBranch;
  const tip = resolveRef(repo, ref);
  if (tip === null) {
    sendError(ctx.res, 404, 'Not Found');
    return true;
  }
  // Newest first: depth-first from the tip, parents after their children.
  const seen = new Set<string>();
  const order: string[] = [];
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  const params = pageParams(ctx.query);
  const { page, link } = paginate(order, params, linkBase(ctx.req, ctx.origin));
  const headers: Record<string, string> = {};
  if (link !== null) headers.link = link;
  const out: Array<Record<string, unknown>> = [];
  for (const sha of page) {
    const entry = commitJson(repo, sha);
    if (entry !== null) out.push(entry);
  }
  sendJson(ctx.res, 200, out, headers);
  return true;
}

function createRef(ctx: Ctx, owner: string, name: string): boolean {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) return true;
  const body = bodyOf(ctx);
  const ref = stringField(body, 'ref');
  const sha = stringField(body, 'sha');
  if (!ref.startsWith('refs/') || !isObjectId(sha)) {
    sendError(ctx.res, 422, 'Invalid ref or sha');
    return true;
  }
  if (repo.refs.has(ref)) {
    sendError(ctx.res, 422, 'Reference already exists');
    return true;
  }
  const object = repo.objects.get(sha);
  if (!object || (object.type !== 'commit' && object.type !== 'tag')) {
    sendError(ctx.res, 422, 'Object does not exist');
    return true;
  }
  repo.refs.set(ref, sha);
  store.touch(repo);
  sendJson(ctx.res, 201, { ref, object: { sha, type: object.type, url: '' } });
  return true;
}

// -------------------------------------------------------------------------------------------
// contents
// -------------------------------------------------------------------------------------------

function contentsRoute(ctx: Ctx, owner: string, name: string, pathSegments: string[], method: string): boolean {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) return true;
  const path = pathSegments.map((segment) => decodeURIComponent(segment)).join('/');
  if (method === 'PUT') return putContents(ctx, repo, path);
  if (method === 'GET') return getContents(ctx, repo, path);
  if (method === 'DELETE') return deleteContents(ctx, repo, path);
  sendError(ctx.res, 404, 'Not Found');
  return true;
}

function putContents(ctx: Ctx, repo: Repo, path: string): boolean {
  const body = bodyOf(ctx);
  const message = stringField(body, 'message');
  const contentB64 = stringField(body, 'content');
  if (message === '' || contentB64 === '') {
    sendError(ctx.res, 422, 'message and content are required');
    return true;
  }
  const branch = stringField(body, 'branch') || repo.defaultBranch;
  const tipOid = repo.refs.get(`refs/heads/${branch}`);
  if (tipOid === undefined && repo.refs.size > 0) {
    sendError(ctx.res, 404, 'Branch not found');
    return true;
  }
  let content: Buffer;
  try {
    content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    sendError(ctx.res, 422, 'content is not valid base64');
    return true;
  }
  // The file's current blob, if any, on this branch.
  let currentOid: string | null = null;
  if (tipOid !== undefined) {
    const object = repo.objects.get(tipOid);
    if (object?.type === 'commit') {
      const entry = treeEntryAtPath(repoLookup(repo), parseCommit(object.data).tree, path);
      if (entry && entry.mode !== '40000') currentOid = entry.oid;
    }
  }
  const sha = stringField(body, 'sha');
  if (currentOid !== null) {
    // Updating an existing file: a sha is required and must be the current blob.
    if (sha === '') {
      sendError(ctx.res, 422, 'file already exists');
      return true;
    }
    if (sha.toLowerCase() !== currentOid.toLowerCase()) {
      sendError(ctx.res, 409, 'sha does not match the current file');
      return true;
    }
  } else if (sha !== '') {
    sendError(ctx.res, 422, 'sha must not be given for a new file');
    return true;
  }
  const isUpdate = currentOid !== null;
  const blobOid = hashObject('blob', content);
  repo.objects.set(blobOid, { type: 'blob', data: content });
  const commitSha = commitFiles(repo, branch, message, (files) => {
    files.set(path, { oid: blobOid, mode: '100644' });
  });
  const base = path.split('/').pop() ?? path;
  sendJson(ctx.res, isUpdate ? 200 : 201, {
    content: {
      name: base,
      path,
      sha: blobOid,
      size: content.length,
      type: 'file',
      encoding: 'base64',
      content: content.toString('base64'),
    },
    commit: { sha: commitSha },
  });
  return true;
}

function getContents(ctx: Ctx, repo: Repo, path: string): boolean {
  const ref = ctx.query.get('ref') ?? repo.defaultBranch;
  const tip = resolveRef(repo, ref);
  if (tip === null) {
    sendError(ctx.res, 404, 'Not Found');
    return true;
  }
  const object = repo.objects.get(tip);
  if (!object || object.type !== 'commit') {
    sendError(ctx.res, 404, 'Not Found');
    return true;
  }
  const rootTree = parseCommit(object.data).tree;
  const entry = treeEntryAtPath(repoLookup(repo), rootTree, path);
  if (entry === null) {
    sendError(ctx.res, 404, 'Not Found');
    return true;
  }
  if (entry.mode === '40000') {
    const treeObject = repo.objects.get(entry.oid);
    if (!treeObject || treeObject.type !== 'tree') {
      sendError(ctx.res, 404, 'Not Found');
      return true;
    }
    const out: Array<Record<string, unknown>> = [];
    for (const child of parseTree(treeObject.data)) {
      const childPath = `${path}/${child.name}`;
      let size = 0;
      if (child.mode !== '40000') {
        const blob = repo.objects.get(child.oid);
        size = blob?.data.length ?? 0;
      }
      out.push({
        type: child.mode === '40000' ? 'dir' : 'file',
        name: child.name,
        path: childPath,
        sha: child.oid,
        size,
      });
    }
    sendJson(ctx.res, 200, out);
    return true;
  }
  const blob = repo.objects.get(entry.oid);
  if (!blob || blob.type !== 'blob') {
    sendError(ctx.res, 404, 'Not Found');
    return true;
  }
  const base = path.split('/').pop() ?? path;
  sendJson(ctx.res, 200, {
    type: 'file',
    encoding: 'base64',
    content: blob.data.toString('base64'),
    sha: entry.oid,
    size: blob.data.length,
    name: base,
    path,
  });
  return true;
}

function deleteContents(ctx: Ctx, repo: Repo, path: string): boolean {
  const body = bodyOf(ctx);
  const message = stringField(body, 'message');
  const branch = stringField(body, 'branch') || repo.defaultBranch;
  const tipOid = repo.refs.get(`refs/heads/${branch}`);
  if (tipOid === undefined) {
    sendError(ctx.res, 404, 'Not Found');
    return true;
  }
  const object = repo.objects.get(tipOid);
  if (!object || object.type !== 'commit') {
    sendError(ctx.res, 404, 'Not Found');
    return true;
  }
  const entry = treeEntryAtPath(repoLookup(repo), parseCommit(object.data).tree, path);
  if (entry === null || entry.mode === '40000') {
    sendError(ctx.res, 404, 'Not Found');
    return true;
  }
  const sha = stringField(body, 'sha');
  if (sha !== '' && sha.toLowerCase() !== entry.oid.toLowerCase()) {
    sendError(ctx.res, 409, 'sha does not match the current file');
    return true;
  }
  const commitSha = commitFiles(repo, branch, message === '' ? `Delete ${path}` : message, (files) => {
    files.delete(path);
  });
  sendJson(ctx.res, 200, { commit: { sha: commitSha } });
  return true;
}

// -------------------------------------------------------------------------------------------
// labels
// -------------------------------------------------------------------------------------------

function createLabel(ctx: Ctx, owner: string, name: string): boolean {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) return true;
  const body = bodyOf(ctx);
  const labelName = stringField(body, 'name');
  const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
  if (labelName === '') {
    sendError(ctx.res, 422, 'name is required');
    return true;
  }
  const label: Label = { name: labelName, color };
  repo.labels.set(labelName, label);
  sendJson(ctx.res, 201, labelJson(label));
  return true;
}

function listLabels(ctx: Ctx, owner: string, name: string): boolean {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) return true;
  sendJson(ctx.res, 200, [...repo.labels.values()].map(labelJson));
  return true;
}

// -------------------------------------------------------------------------------------------
// issues
// -------------------------------------------------------------------------------------------

function createIssue(ctx: Ctx, owner: string, name: string): boolean {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) return true;
  const body = bodyOf(ctx);
  const title = stringField(body, 'title');
  const issueBody = typeof body.body === 'string' ? body.body : '';
  if (title === '') {
    sendError(ctx.res, 422, 'title is required');
    return true;
  }
  const labels: Label[] = [];
  if (Array.isArray(body.labels)) {
    for (const entry of body.labels) {
      if (typeof entry !== 'string') continue;
      const label = repo.labels.get(entry);
      if (!label) {
        sendError(ctx.res, 422, `label "${entry}" does not exist`);
        return true;
      }
      labels.push(label);
    }
  }
  const issue = store.createIssue(repo, title, issueBody, labels);
  sendJson(ctx.res, 201, issueJson(issue, repo));
  return true;
}

function listIssues(ctx: Ctx, owner: string, name: string): boolean {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) return true;
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  if (sort === 'created') {
    issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  }
  const params = pageParams(ctx.query);
  const { page, link } = paginate(issues, params, linkBase(ctx.req, ctx.origin));
  const headers: Record<string, string> = {};
  if (link !== null) headers.link = link;
  sendJson(ctx.res, 200, page.map((issue) => issueJson(issue, repo)), headers);
  return true;
}

function issueNumber(segment: string): number | null {
  const n = Number(segment);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function getIssue(ctx: Ctx, owner: string, name: string, segment: string): boolean {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) return true;
  const number = issueNumber(segment);
  const issue = number === null ? undefined : repo.issues.get(number);
  if (!issue) {
    sendError(ctx.res, 404, 'Not Found');
    return true;
  }
  sendJson(ctx.res, 200, issueJson(issue, repo));
  return true;
}

function patchIssue(ctx: Ctx, owner: string, name: string, segment: string): boolean {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) return true;
  const number = issueNumber(segment);
  const issue = number === null ? undefined : repo.issues.get(number);
  if (!issue) {
    sendError(ctx.res, 404, 'Not Found');
    return true;
  }
  const body = bodyOf(ctx);
  if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  issue.updatedAt = nextIsoTime();
  sendJson(ctx.res, 200, issueJson(issue, repo));
  return true;
}

function createComment(ctx: Ctx, owner: string, name: string, segment: string): boolean {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) return true;
  const number = issueNumber(segment);
  const issue = number === null ? undefined : repo.issues.get(number);
  if (!issue) {
    sendError(ctx.res, 404, 'Not Found');
    return true;
  }
  const body = bodyOf(ctx);
  const text = typeof body.body === 'string' ? body.body : '';
  if (text === '') {
    sendError(ctx.res, 422, 'body is required');
    return true;
  }
  const comment = { id: store.nextEntityId(), body: text, userLogin: VIEWER.login, createdAt: nextIsoTime() };
  issue.comments.push(comment);
  issue.updatedAt = nextIsoTime();
  sendJson(ctx.res, 201, commentJson(comment));
  return true;
}

function listComments(ctx: Ctx, owner: string, name: string, segment: string): boolean {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) return true;
  const number = issueNumber(segment);
  const issue = number === null ? undefined : repo.issues.get(number);
  if (!issue) {
    sendError(ctx.res, 404, 'Not Found');
    return true;
  }
  sendJson(ctx.res, 200, issue.comments.map(commentJson));
  return true;
}

// -------------------------------------------------------------------------------------------
// pull requests
// -------------------------------------------------------------------------------------------

function createPull(ctx: Ctx, owner: string, name: string): boolean {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) return true;
  const body = bodyOf(ctx);
  const title = stringField(body, 'title');
  const pullBody = typeof body.body === 'string' ? body.body : '';
  const head = stringField(body, 'head');
  const base = stringField(body, 'base');
  if (title === '' || head === '' || base === '') {
    sendError(ctx.res, 422, 'title, head and base are required');
    return true;
  }
  if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
    sendError(ctx.res, 422, 'head or base branch does not exist');
    return true;
  }
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.head === head && existing.base === base) {
      sendError(ctx.res, 422, 'A pull request already exists for this head and base');
      return true;
    }
  }
  const pull = store.createPull(repo, title, pullBody, head, base);
  sendJson(ctx.res, 201, pullJson(repo, pull));
  return true;
}

function listPulls(ctx: Ctx, owner: string, name: string): boolean {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) return true;
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => b.seq - a.seq);
  const params = pageParams(ctx.query);
  const { page, link } = paginate(pulls, params, linkBase(ctx.req, ctx.origin));
  const headers: Record<string, string> = {};
  if (link !== null) headers.link = link;
  sendJson(ctx.res, 200, page.map((pull) => pullJson(repo, pull)), headers);
  return true;
}

function getPull(ctx: Ctx, owner: string, name: string, segment: string): boolean {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) return true;
  const number = issueNumber(segment);
  const pull = number === null ? undefined : repo.pulls.get(number);
  if (!pull) {
    sendError(ctx.res, 404, 'Not Found');
    return true;
  }
  sendJson(ctx.res, 200, pullJson(repo, pull));
  return true;
}

function listPullFiles(ctx: Ctx, owner: string, name: string, segment: string): boolean {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) return true;
  const number = issueNumber(segment);
  const pull = number === null ? undefined : repo.pulls.get(number);
  if (!pull) {
    sendError(ctx.res, 404, 'Not Found');
    return true;
  }
  const lookup = repoLookup(repo);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headTip || !baseTip) {
    sendError(ctx.res, 404, 'Not Found');
    return true;
  }
  const base = mergeBase(lookup, headTip, baseTip) ?? baseTip;
  const baseTree = parseCommit(repo.objects.get(base)!.data).tree;
  const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  sendJson(ctx.res, 200, diffFiles(lookup, baseTree, headTree));
  return true;
}

/** Squash-merge a pull request; returns the merge commit sha, or null on conflict. */
export function squashMerge(repo: Repo, pull: Pull): string | null {
  const lookup = repoLookup(repo);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (!headTip || !baseTip) return null;
  const base = mergeBase(lookup, headTip, baseTip);
  if (base === null) return null;
  const baseTree = parseCommit(repo.objects.get(base)!.data).tree;
  const oursTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
  const theirsTree = parseCommit(repo.objects.get(headTip)!.data).tree;
  const merged = threeWayMerge(flattenTree(lookup, baseTree), flattenTree(lookup, oursTree), flattenTree(lookup, theirsTree));
  if (merged.conflicts.length > 0) return null;
  const { rootOid, trees } = buildTreeFromFiles(merged.files);
  for (const [oid, object] of trees) repo.objects.set(oid, object);
  const author = `${VIEWER.name} <${VIEWER.email}>`;
  const data = buildCommit({
    tree: rootOid,
    parents: [baseTip],
    message: `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}\n`,
    author,
    committer: author,
    timestamp: nextCommitTimestamp(),
  });
  const mergeSha = hashObject('commit', data);
  repo.objects.set(mergeSha, { type: 'commit', data });
  repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nextIsoTime();
  pull.mergeSha = mergeSha;
  pull.updatedAt = nextIsoTime();
  store.touch(repo);
  return mergeSha;
}

function mergePull(ctx: Ctx, owner: string, name: string, segment: string): boolean {
  const repo = needRepo(ctx, owner, name);
  if (repo === null) return true;
  const number = issueNumber(segment);
  const pull = number === null ? undefined : repo.pulls.get(number);
  if (!pull) {
    sendError(ctx.res, 404, 'Not Found');
    return true;
  }
  if (pull.merged || pull.state === 'closed') {
    sendError(ctx.res, 405, 'Pull request is already closed');
    return true;
  }
  const mergeSha = squashMerge(repo, pull);
  if (mergeSha === null) {
    sendError(ctx.res, 405, 'Merge conflict');
    return true;
  }
  sendJson(ctx.res, 200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
  return true;
}

// Referenced by the GraphQL module for its merge mutation.
export function findPullByNumber(repo: Repo, number: number): Pull | undefined {
  return repo.pulls.get(number);
}

export function findIssueByNumber(repo: Repo, number: number): Issue | undefined {
  return repo.issues.get(number);
}

export function headTipOf(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

export function isAncestorInRepo(repo: Repo, ancestor: string, tip: string): boolean {
  return isAncestor(repoLookup(repo), ancestor, tip);
}
