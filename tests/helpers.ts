import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished, vi } from 'vitest';
import type { Config } from '@pentice/booking-service/config';

/** Retries `assertion` until it passes or five seconds are up, then fails with its last error. */
export const eventually = <T>(assertion: () => T | Promise<T>): Promise<T> =>
  vi.waitFor(assertion, { timeout: 5_000, interval: 10 });

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A temporary directory that is removed when the test ends. */
export async function makeTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'pentice-'));
  onTestFinished(() => rm(path, { recursive: true, force: true }));
  return path;
}

export const postJson = (url: string, body: unknown) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

export const readJsonFile = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, 'utf8')) as T;

/** A booking service on a free loopback port, with retries a test can watch. */
export const bookingConfig = (DATA_DIR: string, overrides: Partial<Config> = {}): Config => ({
  PORT: 0,
  HOST: '127.0.0.1',
  DATA_DIR,
  CODE_MAX_ATTEMPTS: 10,
  BACKOFF_BASE_MS: 10,
  BACKOFF_CAP_MS: 40,
  DELIVERY_TIMEOUT_MS: 2_000,
  ATTENTION_THRESHOLD: 10,
  ...overrides,
});

/** Passed to either service by every test, so that it logs nothing. */
export const SILENT = { logger: false };

/** The `code` of a refusal, from Fastify's `{statusCode, code, error, message}` body. */
export const errorCode = async (response: Response) =>
  ((await response.json()) as { code?: string }).code;

export interface StubRequest {
  path: string | undefined;
  authorization: string | undefined;
  body: string;
}

/**
 * A plain HTTP server standing in for the other service. It records every request and
 * hands it to `onRequest`, which answers it, or leaves it open until the test ends.
 */
export async function startStub(
  onRequest: (request: StubRequest, response: ServerResponse) => void = (_request, response) => {
    response.writeHead(202).end();
  },
) {
  const requests: StubRequest[] = [];
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const request = {
        path: incoming.url,
        authorization: incoming.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(request);
      onRequest(request, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  onTestFinished(close);
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close };
}
