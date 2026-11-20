// Entry point: boot the forge on an ephemeral port, register that port with the
// suite environment, serve until the environment reports done, then exit 0.
// The suite drives everything through MAKEFUN_ENV_URL; the shop token in
// MAKEFUN_SHOP_TOKEN authenticates every request and names the viewer.

import { createApp } from './app.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl === undefined || envUrl === '') {
  console.error('MAKEFUN_ENV_URL is not set; the forge only runs inside the make.fun suite environment.');
  process.exit(1);
}

const server = createApp();

// If the harness kills the forge instead of reporting done, still exit cleanly
// rather than dying on the signal with sockets open.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), 500).unref();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function register(port: number): Promise<void> {
  // The environment may still be coming up when the forge starts, so retry with a
  // short backoff; 200/409 mean the registration landed, 400/405 are fatal.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`registration refused with status ${response.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('registration refused')) throw err;
    }
    await sleep(250);
  }
  throw new Error('could not register with the suite environment');
}

async function waitForDone(): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`);
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Transient environment hiccup; keep polling.
    }
    await sleep(200);
  }
}

const address = await new Promise<{ port: number }>((resolveListen, rejectListen) => {
  server.once('error', rejectListen);
  server.listen(0, '127.0.0.1', () => {
    const bound = server.address();
    if (bound === null || typeof bound === 'string') {
      rejectListen(new Error('server did not bind a TCP port'));
      return;
    }
    resolveListen({ port: bound.port });
  });
});

await register(address.port);
await waitForDone();

await new Promise<void>((resolveClose) => {
  server.close(() => resolveClose());
  server.closeIdleConnections();
});
process.exit(0);
