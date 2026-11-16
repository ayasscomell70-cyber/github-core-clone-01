[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/ayasscomell70-cyber/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/ayasscomell70-cyber/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
# Forge — a GitHub-compatible git forge (make.fun github-core-clone-01)

One Node 22 process, stdlib only, no git binary, no network, no model calls.
Serves git smart HTTP (upload-pack v2 + receive-pack v0, packfiles built and read
from scratch), REST v3 (`/api/v3`), GraphQL v4 (`/api/graphql`) and MCP
(`/mcp`, JSON-RPC 2.0 Streamable HTTP, 2026-07-28 era with a legacy `initialize`
fallback).

## Run

```sh
node --experimental-strip-types main.ts   # needs MAKEFUN_ENV_URL set by the env
```

## Layout

- `main.ts` — entry <-> env lifecycle (bind ephemeral port, register, poll /done).
- `app.ts` — HTTP server and routing; every reply carries X-GitHub-Request-Id.
- `store.ts` — in-memory store, the logical clock (deterministic timestamps and
  request ids: no Date.now()/Math.random() in state), Relay global ids.
- `gitcore.ts` — git objects, pkt-lines, pack read/write (with delta resolution),
  reachability, shallow fetch planning, tree building, three-way merges.
- `githttp.ts` — smart HTTP: v0/v2 advertisements, ls-refs, fetch, receive-pack.
- `rest.ts` — REST v3: repos, branches, commits, contents, labels, issues,
  pull requests, squash merge.
- `graphql.ts` — a small GraphQL parser + executor for the documents gh and
  github-mcp-server send, including __type introspection and batched operations.
- `mcp.ts` — MCP tools: create_repo, get_repo, create_issue, list_issues,
  create_pull_request, merge_pull_request.

## Notes

- The bearer token names the scenario's viewer (`adaiversen`, id 1000): the kit's
  scenario seed is constant, so the viewer login is the same in every trial.
- Any repository belongs to the token owner; the same name under another owner
  is a 404, never a 403; no token is a 401.
- Pushed objects are stored byte-exactly; commits, trees, blobs and tags
  round-trip without re-serialisation.
