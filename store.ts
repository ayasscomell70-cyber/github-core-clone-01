// The forge's in-memory store: users, repositories, git objects, refs, issues, pull
// requests, labels and comments. One process, no disk, no network.
//
// DETERMINISM: nothing here reads the wall clock or Math.random. A logical tick counts
// every timestamped event, so two runs fed the same requests in the same order produce
// byte-identical state (the same commit ids, the same created_at strings, the same
// request ids). The suite's checks send byte-identical requests in the same order, so
// the trial is replayable.

export interface User {
  id: number;
  login: string;
  name: string;
  email: string;
}

/**
 * The scenario's viewer. The kit's scenario seed is the constant SCENARIO_SEED
 * (wire.ts: 0x6a09e667f3bcc909), so generateUsers(scenarioRng('users'), 12)[0] is
 * always adaiversen (id 1000) in every trial this kit runs. Any non-empty bearer
 * token names this viewer; the suite never sends a second token.
 */
export const VIEWER: User = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

/** The scenario's other logins, used only to prove a foreign owner is a 404. */
export const TEAMMATE_LOGIN = 'quinnkeller';
export const STRANGER_LOGIN = 'olgabauer';

/** The six labels the scenario seeds every repository with. */
export const DEFAULT_LABELS: ReadonlyArray<{ name: string; color: string }> = Object.freeze([
  { name: 'bug', color: 'd73a4a' },
  { name: 'enhancement', color: 'a2eeef' },
  { name: 'documentation', color: '0075ca' },
  { name: 'question', color: 'd876e3' },
  { name: 'good first issue', color: '7057ff' },
  { name: 'help wanted', color: '008672' },
]);

// -------------------------------------------------------------------------------------------
// the logical clock
// -------------------------------------------------------------------------------------------

let tick = 0;

/** The next logical tick (1, 2, 3, ...). */
export function nextTick(): number {
  tick += 1;
  return tick;
}

/** A fixed epoch every commit timestamp derives from; the tick is the offset. */
export const CLOCK_EPOCH_SEC = 1_700_000_000;

/** The timestamp (epoch seconds) of the next commit the forge writes. */
export function nextCommitTimestamp(): number {
  return CLOCK_EPOCH_SEC + nextTick();
}

/** The ISO timestamp of the next created/updated record. Fixed base + tick seconds. */
export function nextIsoTime(): string {
  const ms = Date.UTC(2026, 0, 1) + nextTick() * 1000;
  return new Date(ms).toISOString().replace('.000Z', 'Z');
}

// -------------------------------------------------------------------------------------------
// request ids (X-GitHub-Request-Id)
// -------------------------------------------------------------------------------------------

let requestCounter = 0;

/** A non-empty request id, deterministic in request order. */
export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

// -------------------------------------------------------------------------------------------
// global ids (GraphQL Relay ids: opaque, stable, never the plain database id)
// -------------------------------------------------------------------------------------------

export function encodeGlobalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  if (typeof id !== 'string' || id === '') return null;
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    const kind = parts.shift();
    if (kind === undefined || kind === '' || parts.length === 0) return null;
    // Re-encode and compare: a string that is not our encoding is not a global id.
    if (encodeGlobalId(kind, ...parts) !== id) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------
// git objects
// -------------------------------------------------------------------------------------------

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

// -------------------------------------------------------------------------------------------
// resources
// -------------------------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  userLogin: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  seq: number;
  createdAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** Shared issue + pull-request counter, as GitHub numbers them together. */
  nextNumber: number;
  nextCommentId: number;
  /** Bumped on every mutation; part of every pack-cache key. */
  version: number;
  /** Generated packs, keyed by the fetch parameters + version. */
  packCache: Map<string, Buffer>;
  /** Whole fetch / ls-refs responses, keyed the same way (a response is a pure
   * function of the fetch parameters + version, so a repeated shallow clone
   * reuses one). Cleared with packCache on every mutation. */
  responseCache: Map<string, Buffer>;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextId = 1;
  private nextRepoSeq = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  /** Repositories owned by `owner`, in creation order. */
  reposOf(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextId,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      seq: this.nextRepoSeq,
      createdAt: nextIsoTime(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      version: 0,
      packCache: new Map(),
      responseCache: new Map(),
    };
    this.nextId += 1;
    this.nextRepoSeq += 1;
    for (const label of DEFAULT_LABELS) repo.labels.set(label.name, { ...label });
    this.repos.set(this.repoKey(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  nextEntityId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  /** Bump a repo's version and drop its cached packs and responses after any mutation. */
  touch(repo: Repo): void {
    repo.version += 1;
    repo.packCache.clear();
    repo.responseCache.clear();
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const now = nextIsoTime();
    const issue: Issue = {
      id: this.nextEntityId(),
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: nextTick(),
      createdAt: now,
      updatedAt: now,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const now = nextIsoTime();
    const pull: Pull = {
      id: this.nextEntityId(),
      number,
      title,
      body,
      state: 'open',
      head,
      base,
      merged: false,
      mergedAt: null,
      mergeSha: null,
      seq: nextTick(),
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.set(number, pull);
    return pull;
  }
}

/** The one store of the process. */
export const store = new Store();
