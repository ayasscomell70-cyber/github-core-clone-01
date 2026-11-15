// Entrypoint for the forge: boot the HTTP server, register it with the trial
// harness, and wait until the harness declares the trial finished.
//
// The harness hands us its base URL through MAKEFUN_ENV_URL. The contract is
// deliberately small:
//   1. start the server on an ephemeral port (never a fixed one),
//   2. POST {"port": <port>} to <env>/register,
//   3. poll GET <env>/done until it answers {"done": true},
//   4. shut the server down and exit 0.
//
// Everything the server itself does — git smart HTTP, REST v3, GraphQL v4,
// MCP — lives in app.ts. This file only owns the lifecycle above.

import { createApp } from './app.ts';

const REGISTER_PATH = '/register';
const DONE_PATH = '/done';

// First retry waits this long; each failure doubles the wait up to the cap.
const FIRST_WAIT_MS = 100;
const MAX_WAIT_MS = 2000;

// Give up on a single HTTP round-trip after this long so a stuck harness
// cannot wedge the entrypoint forever.
const REQUEST_TIMEOUT_MS = 5000;

// How many times to retry the register call before admitting defeat.
const REGISTER_ATTEMPTS = 10;

/** Pause for `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Read the harness base URL, or fail fast when it is missing. */
function harnessBase(): string {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (raw === undefined || raw.trim() === '') {
    throw new Error('MAKEFUN_ENV_URL is not set');
  }
  return raw.replace(/\/+$/, '');
}

async function postJson(url: string, payload: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`POST ${url} failed with status ${res.status}`);
  }
  return (await res.json()) as unknown;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`GET ${url} failed with status ${res.status}`);
  }
  return (await res.json()) as unknown;
}

/** Tell the harness which port the server is on, retrying briefly. */
async function register(base: string, port: number): Promise<void> {
  let wait = FIRST_WAIT_MS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      await postJson(`${base}${REGISTER_PATH}`, { port });
      return;
    } catch (err) {
      if (attempt >= REGISTER_ATTEMPTS) throw err;
      process.stderr.write(
        `[entry] register attempt ${attempt} failed, retrying in ${wait}ms\n`,
      );
      await sleep(wait);
      wait = Math.min(wait * 2, MAX_WAIT_MS);
    }
  }
}

/** Keep asking the harness whether the trial is over. */
async function waitForDone(base: string): Promise<void> {
  let wait = FIRST_WAIT_MS;
  for (;;) {
    try {
      const body = await getJson(`${base}${DONE_PATH}`);
      if (
        typeof body === 'object' &&
        body !== null &&
        (body as { done?: unknown }).done === true
      ) {
        return;
      }
    } catch (err) {
      process.stderr.write(
        `[entry] done poll failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    await sleep(wait);
    wait = Math.min(wait * 2, MAX_WAIT_MS);
  }
}

type RunningServer = ReturnType<typeof createApp>;

/** Start the server on an ephemeral port and report the port it picked. */
async function startServer(): Promise<{ server: RunningServer; port: number }> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Port 0 asks the OS for any free port; we never bind a fixed one.
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) {
    server.close();
    throw new Error('server did not bind to a port');
  }
  return { server, port: address.port };
}

/** Stop accepting connections and wait for the server to close. */
async function stopServer(server: RunningServer): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function main(): Promise<number> {
  let base: string;
  try {
    base = harnessBase();
  } catch (err) {
    process.stderr.write(
      `[entry] ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }

  const { server, port } = await startServer();
  try {
    await register(base, port);
    await waitForDone(base);
  } finally {
    await stopServer(server);
  }
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    process.stderr.write(
      `[entry] fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  });
