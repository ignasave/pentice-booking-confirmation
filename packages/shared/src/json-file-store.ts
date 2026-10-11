import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Mutex } from 'async-mutex';
import writeFileAtomic from 'write-file-atomic';

/** Returned by a mutator to report that it changed nothing: no file is written. */
export const UNCHANGED = Symbol('unchanged');

export class CorruptStateError extends Error {}

export interface JsonFileStore<T> {
  /** The last committed state. Treat it as read-only. */
  read(): Promise<T>;
  /** Runs `mutator` on a copy of the committed state and resolves once the result is on disk. */
  update(mutator: (state: T) => T | typeof UNCHANGED): Promise<void>;
}

/** Opens the state file at `path`, or starts from `defaultState` when there is none yet. */
export async function openJsonFileStore<T extends { schemaVersion: number }>(
  path: string,
  defaultState: T,
): Promise<JsonFileStore<T>> {
  await mkdir(dirname(path), { recursive: true });
  let committed = defaultState;
  const content = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (content !== undefined) {
    let parsed: T | undefined;
    try {
      parsed = JSON.parse(content) as T;
    } catch {
      // Not rethrown as the cause: the parser's message quotes the content of the file.
    }
    // Only the version is checked: the shape behind a matching version is trusted.
    if (!parsed || parsed.schemaVersion !== defaultState.schemaVersion) {
      throw new CorruptStateError(`State file ${path} is corrupt: not JSON of this schemaVersion`);
    }
    committed = parsed;
  }

  const mutex = new Mutex();
  return {
    read: () => Promise.resolve(committed),
    // One update at a time. The copy replaces the committed state only once it is on disk
    // (temp file, fsync, rename), so a failed write leaves both as they were.
    update: (mutator) =>
      mutex.runExclusive(async () => {
        const next = mutator(structuredClone(committed));
        if (next === UNCHANGED) return;
        await writeFileAtomic(path, JSON.stringify(next));
        committed = next;
      }),
  };
}
