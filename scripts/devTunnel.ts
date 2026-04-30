/**
 * dev:tunnel orchestrator
 *
 * Spins up a Cloudflare quick tunnel pointing at the local Duffy HTTP server,
 * temporarily repoints the active Kapso WhatsApp webhook at the tunnel URL,
 * runs `pnpm dev`, and on exit restores the original webhook URL and tears
 * down both child processes.
 *
 * Usage:  pnpm dev:tunnel
 */

import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import process from 'node:process';

// --- ANSI color helpers (no chalk dep) -------------------------------------

const ANSI = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
} as const;

function paint(color: keyof typeof ANSI, text: string): string {
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

function logOrch(message: string): void {
  console.log(`${paint('cyan', '[dev-tunnel]')} ${message}`);
}

function logOrchWarn(message: string): void {
  console.warn(`${paint('cyan', '[dev-tunnel]')} ${paint('yellow', 'warn:')} ${message}`);
}

function logOrchError(message: string): void {
  console.error(`${paint('cyan', '[dev-tunnel]')} ${paint('red', 'error:')} ${message}`);
}

// --- Config / env ----------------------------------------------------------

const KAPSO_API_KEY = process.env.KAPSO_API_KEY;
const KAPSO_PHONE_NUMBER_ID = process.env.KAPSO_PHONE_NUMBER_ID;
const KAPSO_API_BASE_URL = (process.env.KAPSO_API_BASE_URL ?? 'https://app.kapso.ai').replace(/\/+$/, '');
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const LOCAL_PORT = Number.parseInt(process.env.PORT ?? '3000', 10) || 3000;
const LOCAL_TARGET = `http://localhost:${LOCAL_PORT}`;

const TUNNEL_URL_REGEX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const TUNNEL_RESOLVE_TIMEOUT_MS = 30_000;
const RESTORE_FETCH_TIMEOUT_MS = 5_000;
const CHILD_GRACE_MS = 3_000;

// --- Kapso API client ------------------------------------------------------

interface KapsoWebhook {
  id: string;
  url: string;
  kind?: string;
  events?: string[];
}

interface KapsoListResponse {
  // The Kapso API may return either { data: [...] } or { whatsapp_webhooks: [...] }
  // depending on endpoint version. Normalize defensively.
  data?: KapsoWebhook[];
  whatsapp_webhooks?: KapsoWebhook[];
}

async function kapsoRequest<T = unknown>(
  path: string,
  init: RequestInit = {},
  timeoutMs?: number,
): Promise<T> {
  if (!KAPSO_API_KEY) {
    throw new Error('KAPSO_API_KEY is not set');
  }
  const url = `${KAPSO_API_BASE_URL}${path}`;
  const headers = new Headers(init.headers);
  headers.set('X-API-Key', KAPSO_API_KEY);
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

  const controller = timeoutMs ? new AbortController() : undefined;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
  try {
    const res = await fetch(url, { ...init, headers, signal: controller?.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Kapso request failed (status=${res.status}) ${text}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function listKapsoWebhooks(phoneNumberId: string): Promise<KapsoWebhook[]> {
  const path = `/platform/v1/whatsapp/phone_numbers/${encodeURIComponent(phoneNumberId)}/webhooks?kind=kapso`;
  const body = await kapsoRequest<KapsoListResponse | KapsoWebhook[]>(path);
  if (Array.isArray(body)) return body;
  return body.data ?? body.whatsapp_webhooks ?? [];
}

async function patchKapsoWebhookUrl(
  phoneNumberId: string,
  webhookId: string,
  newUrl: string,
  timeoutMs?: number,
): Promise<void> {
  const path = `/platform/v1/whatsapp/phone_numbers/${encodeURIComponent(phoneNumberId)}/webhooks/${encodeURIComponent(webhookId)}`;
  await kapsoRequest(
    path,
    {
      method: 'PATCH',
      body: JSON.stringify({ whatsapp_webhook: { url: newUrl } }),
    },
    timeoutMs,
  );
}

// --- Webhook selection -----------------------------------------------------

function hostOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).host;
  } catch {
    return null;
  }
}

function pathOf(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.pathname}${u.search}`;
  } catch {
    return '/';
  }
}

interface ChosenWebhook {
  id: string;
  originalUrl: string;
  pathSuffix: string;
}

function chooseWebhook(candidates: KapsoWebhook[]): ChosenWebhook {
  if (candidates.length === 0) {
    throw new Error(
      `No kapso-kind webhooks found for KAPSO_PHONE_NUMBER_ID=${KAPSO_PHONE_NUMBER_ID}. ` +
        'Create one in the Kapso dashboard before using dev:tunnel.',
    );
  }

  let chosen: KapsoWebhook;
  if (candidates.length === 1) {
    chosen = candidates[0]!;
  } else {
    const publicHost = PUBLIC_BASE_URL ? hostOf(PUBLIC_BASE_URL) : null;
    const byPublicHost = publicHost
      ? candidates.find((w) => hostOf(w.url) === publicHost)
      : undefined;
    const byRailway = candidates.find((w) => /railway/i.test(w.url));
    chosen = byPublicHost ?? byRailway ?? candidates[0]!;

    logOrchWarn(
      `Multiple kapso webhooks found (${candidates.length}). Candidates:\n` +
        candidates.map((w) => `    - id=${w.id} url=${w.url}`).join('\n') +
        `\n  Picked id=${chosen.id} url=${chosen.url}`,
    );
  }

  return {
    id: chosen.id,
    originalUrl: chosen.url,
    pathSuffix: pathOf(chosen.url),
  };
}

// --- Process orchestration -------------------------------------------------

interface ChildHandle {
  name: string;
  proc: ChildProcess;
  exited: boolean;
}

function pipeWithPrefix(child: ChildProcess, prefix: string, color: keyof typeof ANSI): void {
  const tag = paint(color, prefix);
  const onChunk = (stream: 'stdout' | 'stderr') => (data: Buffer) => {
    const text = data.toString('utf8');
    const lines = text.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) {
      const target = stream === 'stderr' ? process.stderr : process.stdout;
      target.write(`${tag} ${line}\n`);
    }
  };
  child.stdout?.on('data', onChunk('stdout'));
  child.stderr?.on('data', onChunk('stderr'));
}

function spawnCloudflared(): ChildHandle {
  let proc: ChildProcess;
  try {
    proc = spawn('cloudflared', ['tunnel', '--url', LOCAL_TARGET], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(
      `Failed to spawn cloudflared: ${(err as Error).message}. Install it via 'brew install cloudflared'.`,
    );
  }
  const handle: ChildHandle = { name: 'tunnel', proc, exited: false };
  proc.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      logOrchError(
        "cloudflared not found on PATH. Install it via 'brew install cloudflared' (macOS) or see https://developers.cloudflare.com/cloudflared/.",
      );
    } else {
      logOrchError(`cloudflared error: ${err.message}`);
    }
  });
  proc.on('exit', () => {
    handle.exited = true;
  });
  pipeWithPrefix(proc, '[tunnel]', 'yellow');
  return handle;
}

function spawnDevServer(): ChildHandle {
  const proc = spawn('pnpm', ['dev'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const handle: ChildHandle = { name: 'dev', proc, exited: false };
  proc.on('error', (err) => logOrchError(`pnpm dev error: ${err.message}`));
  proc.on('exit', () => {
    handle.exited = true;
  });
  pipeWithPrefix(proc, '[dev]', 'green');
  return handle;
}

async function waitForTunnelUrl(handle: ChildHandle, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for trycloudflare.com URL`));
    }, timeoutMs);

    const onData = (data: Buffer): void => {
      const match = data.toString('utf8').match(TUNNEL_URL_REGEX);
      if (match) {
        cleanup();
        resolve(match[0]);
      }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`cloudflared exited before issuing a URL (code=${code} signal=${signal})`));
    };

    function cleanup(): void {
      clearTimeout(timer);
      handle.proc.stdout?.off('data', onData);
      handle.proc.stderr?.off('data', onData);
      handle.proc.off('exit', onExit);
    }

    handle.proc.stdout?.on('data', onData);
    handle.proc.stderr?.on('data', onData);
    handle.proc.on('exit', onExit);
  });
}

async function killChild(handle: ChildHandle): Promise<void> {
  if (handle.exited || !handle.proc.pid) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    handle.proc.once('exit', finish);
    try {
      handle.proc.kill('SIGTERM');
    } catch {
      finish();
      return;
    }
    setTimeout(() => {
      if (!handle.exited) {
        try {
          handle.proc.kill('SIGKILL');
        } catch {
          /* noop */
        }
      }
      finish();
    }, CHILD_GRACE_MS);
  });
}

// --- Main ------------------------------------------------------------------

async function main(): Promise<void> {
  if (!KAPSO_API_KEY) throw new Error('KAPSO_API_KEY is required in .env');
  if (!KAPSO_PHONE_NUMBER_ID) throw new Error('KAPSO_PHONE_NUMBER_ID is required in .env');

  logOrch(paint('bold', `Starting dev tunnel for ${LOCAL_TARGET}`));
  logOrch(`Kapso base: ${paint('gray', KAPSO_API_BASE_URL)}`);

  // 1. Resolve webhook to repoint.
  logOrch('Looking up Kapso webhook for active phone number…');
  const webhooks = await listKapsoWebhooks(KAPSO_PHONE_NUMBER_ID);
  const chosen = chooseWebhook(webhooks);
  logOrch(
    `Selected webhook ${paint('bold', chosen.id)} ${paint('gray', `(original url: ${chosen.originalUrl})`)}`,
  );

  // 2. Spawn cloudflared and wait for public URL.
  logOrch('Starting cloudflared quick tunnel…');
  const tunnel = spawnCloudflared();

  let publicUrl: string;
  try {
    publicUrl = await waitForTunnelUrl(tunnel, TUNNEL_RESOLVE_TIMEOUT_MS);
  } catch (err) {
    await killChild(tunnel);
    throw err;
  }
  logOrch(`Tunnel up: ${paint('bold', publicUrl)}`);

  // 3. PATCH webhook to public URL + original path.
  const newWebhookUrl = `${publicUrl}${chosen.pathSuffix}`;
  logOrch(`Repointing webhook → ${paint('bold', newWebhookUrl)}`);
  try {
    await patchKapsoWebhookUrl(KAPSO_PHONE_NUMBER_ID, chosen.id, newWebhookUrl);
  } catch (err) {
    logOrchError(`Failed to repoint webhook: ${(err as Error).message}`);
    await killChild(tunnel);
    throw err;
  }
  logOrch(paint('green', 'Webhook repointed successfully.'));

  // 4. Start dev server.
  logOrch('Starting `pnpm dev`…');
  const dev = spawnDevServer();

  // 5. Wire cleanup.
  let cleaningUp = false;
  let exitCode = 0;

  const cleanup = async (reason: string): Promise<void> => {
    if (cleaningUp) return;
    cleaningUp = true;
    logOrch(paint('yellow', `Shutting down (${reason}). Restoring webhook and stopping children…`));

    try {
      await patchKapsoWebhookUrl(
        KAPSO_PHONE_NUMBER_ID,
        chosen.id,
        chosen.originalUrl,
        RESTORE_FETCH_TIMEOUT_MS,
      );
      logOrch(paint('green', `Restored webhook to ${chosen.originalUrl}`));
    } catch (err) {
      logOrchError(
        `Failed to restore webhook to ${chosen.originalUrl}: ${(err as Error).message}. ` +
          `You may need to PATCH it manually.`,
      );
      exitCode = exitCode || 1;
    }

    await Promise.all([killChild(tunnel), killChild(dev)]);
    logOrch('Children stopped. Bye.');
    process.exit(exitCode);
  };

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      void cleanup(sig);
    });
  }

  // Treat unexpected death of either child as fatal — trigger cleanup.
  tunnel.proc.on('exit', (code, signal) => {
    if (cleaningUp) return;
    logOrchError(`cloudflared exited unexpectedly (code=${code} signal=${signal}).`);
    exitCode = 1;
    void cleanup('tunnel died');
  });
  dev.proc.on('exit', (code, signal) => {
    if (cleaningUp) return;
    logOrchError(`pnpm dev exited unexpectedly (code=${code} signal=${signal}).`);
    exitCode = code ?? 1;
    void cleanup('dev died');
  });

  logOrch(paint('green', 'All systems go. Press Ctrl+C to stop and restore the original webhook.'));
}

main().catch(async (err) => {
  logOrchError((err as Error).stack ?? String(err));
  process.exit(1);
});
