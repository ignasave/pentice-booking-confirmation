import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';
import type { Config } from '@pentice/booking-service/config';

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

/** A booking service on a free loopback port. */
export const bookingConfig = (DATA_DIR: string, overrides: Partial<Config> = {}): Config => ({
  PORT: 0,
  HOST: '127.0.0.1',
  DATA_DIR,
  CODE_MAX_ATTEMPTS: 10,
  ...overrides,
});

/** Passed to either service by every test, so that it logs nothing. */
export const SILENT = { logger: false };

/** The `code` of a refusal, from Fastify's `{statusCode, code, error, message}` body. */
export const errorCode = async (response: Response) =>
  ((await response.json()) as { code?: string }).code;
