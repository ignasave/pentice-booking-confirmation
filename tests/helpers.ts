import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';

/** A temporary directory that is removed when the test ends. */
export async function makeTempDir(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'pentice-'));
  onTestFinished(() => rm(path, { recursive: true, force: true }));
  return path;
}

export const readJsonFile = async <T>(path: string): Promise<T> =>
  JSON.parse(await readFile(path, 'utf8')) as T;
