import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeliveryPayload } from '@pentice/shared/delivery-payload';
import { eventually, postJson, startStub } from '../helpers';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
/** A child starts a TypeScript runtime before it does anything, which takes about a second. */
const PROCESS_TIMEOUT_MS = 30_000;
const SHUTDOWN_LIMIT_MS = 10_000;
const CORRUPT_STATE = '{"schemaVersion": 1, "bookings": [';

const SERVICES = [
  {
    name: 'booking service',
    entry: 'apps/booking-service/src/main.ts',
    stateFile: 'bookings.json',
  },
  { name: 'guest simulator', entry: 'apps/guest-simulator/src/main.ts', stateFile: 'inbox.json' },
];

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function makeDataDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'pentice-process-'));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}

/**
 * Runs Node with the TypeScript loader as a direct child. The `tsx` command would put a
 * wrapper process in between, and the signal and the exit code would be the wrapper's.
 */
function runNode(args: string[], env: Record<string, string> = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', ...args], {
    cwd: REPO_ROOT,
    env: { PATH: process.env.PATH, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  cleanups.push(() => child.kill('SIGKILL'));

  const output = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output.stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (output.stderr += chunk));

  return {
    output,
    signal: (name: NodeJS.Signals) => child.kill(name),
    /** Resolves with the exit code once the process is gone and its output is complete. */
    exited: new Promise<number | null>((done) => child.once('close', (code) => done(code))),
    /** Resolves with the first capture of `pattern` once the process has printed it. */
    printed: (pattern: RegExp) =>
      vi.waitFor(
        () => {
          const match = pattern.exec(output.stdout);
          if (!match) throw new Error(`Still waiting for ${pattern} in: ${output.stdout}`);
          return match[1] ?? match[0];
        },
        { timeout: PROCESS_TIMEOUT_MS / 2, interval: 20 },
      ),
  };
}

const startService = (entry: string, dataDir: string, env: Record<string, string> = {}) =>
  runNode([entry], { HOST: '127.0.0.1', PORT: '0', DATA_DIR: dataDir, ...env });

const lines = (text: string) => text.split('\n').filter((line) => line !== '');

describe.each(SERVICES)(
  '$name process',
  { timeout: PROCESS_TIMEOUT_MS },
  ({ entry, stateFile }) => {
    it('stops accepting requests and exits 0 within 10 seconds of SIGTERM', async () => {
      const service = startService(entry, await makeDataDir());
      const url = await service.printed(/Server listening at (http:[^"]+)/);
      expect((await fetch(`${url}/health`)).status).toBe(200);

      const signalledAt = performance.now();
      service.signal('SIGTERM');

      expect(await service.exited).toBe(0);
      expect(performance.now() - signalledAt).toBeLessThan(SHUTDOWN_LIMIT_MS);
      await expect(fetch(`${url}/health`)).rejects.toThrow();
    });

    it('exits 0 on SIGINT as well', async () => {
      const service = startService(entry, await makeDataDir());
      await service.printed(/Server listening at/);

      service.signal('SIGINT');

      expect(await service.exited).toBe(0);
    });

    it('exits non-zero and leaves a corrupt state file untouched', async () => {
      const dataDir = await makeDataDir();
      const statePath = join(dataDir, stateFile);
      await writeFile(statePath, CORRUPT_STATE);

      const service = startService(entry, dataDir);

      expect(await service.exited).toBe(1);
      expect(service.output.stderr).toContain('is corrupt');
      expect(await readFile(statePath, 'utf8')).toBe(CORRUPT_STATE);
    });

    it('exits non-zero on configuration it cannot use', async () => {
      const service = runNode([entry], { PORT: 'http', DATA_DIR: await makeDataDir() });

      expect(await service.exited).toBe(1);
      expect(service.output.stderr).toContain('PORT');
    });
  },
);
describe('booking service log', { timeout: PROCESS_TIMEOUT_MS }, () => {
  it('has one line per delivery attempt and never the code, the ack token or the guest', async () => {
    const guest = await startStub();
    const service = startService('apps/booking-service/src/main.ts', await makeDataDir(), {
      GUEST_WEBHOOK_URL: guest.url,
    });
    const url = await service.printed(/Server listening at (http:[^"]+)/);

    await postJson(`${url}/bookings`, { reservationId: 'R123', guest: 'ana@example.com' });
    await eventually(() => expect(guest.requests).toHaveLength(1));
    const delivery = JSON.parse(guest.requests[0]!.body) as DeliveryPayload;
    // A lookup, a wrong token and the real acknowledgement: every request that carries a secret.
    await fetch(`${url}/${delivery.confirmationCode}`);
    for (const token of ['wrong-token', delivery.ackToken]) {
      await fetch(`${url}/deliveries/${delivery.deliveryId}/ack`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      });
    }
    service.signal('SIGTERM');
    expect(await service.exited).toBe(0);

    const log = service.output.stdout + service.output.stderr;
    const attempts = lines(log).filter((line) => line.includes('"Delivery attempt"'));
    // Usually one; a second copy can leave before the acknowledgement arrives.
    expect(JSON.parse(attempts[0]!)).toMatchObject({
      deliveryId: delivery.deliveryId,
      attempt: 1,
      outcome: 'accepted',
      status: 202,
    });
    expect(log).toContain('"Delivery acknowledged"');
    for (const secret of [delivery.confirmationCode, delivery.ackToken, 'ana@example.com']) {
      expect(log).not.toContain(secret);
    }
  });
});
