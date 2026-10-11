import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import writeFileAtomic from 'write-file-atomic';
import { CorruptStateError, openJsonFileStore, UNCHANGED } from './json-file-store';

// The real module, wrapped so that a test can make one write fail.
vi.mock('write-file-atomic', async (importOriginal) => {
  const original = await importOriginal<{ default: typeof writeFileAtomic }>();
  return { default: vi.fn(original.default) };
});

const DEFAULT_STATE = { schemaVersion: 1, count: 0 };
const increment = (state: typeof DEFAULT_STATE) => ({ ...state, count: state.count + 1 });

let directory: string;
let path: string;
const openCounter = () => openJsonFileStore(path, DEFAULT_STATE);
const onDisk = async () => JSON.parse(await readFile(path, 'utf8')) as typeof DEFAULT_STATE;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'pentice-store-'));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  // In a directory that does not exist yet: the store creates it.
  directory = join(root, 'nested');
  path = join(directory, 'state.json');
});

describe('opening', () => {
  it('starts from the default state when there is no file, and writes none', async () => {
    const store = await openCounter();

    expect(await store.read()).toEqual(DEFAULT_STATE);
    expect(await readdir(directory)).toEqual([]);
  });

  it('returns the state committed by an earlier store on the same path', async () => {
    const first = await openCounter();
    await first.update(increment);
    await first.update(increment);

    expect(await (await openCounter()).read()).toEqual({ schemaVersion: 1, count: 2 });
  });

  it.each([
    ['invalid JSON', '{"schemaVersion": 1, "count": '],
    ['a different schemaVersion', '{"schemaVersion":2,"count":7}'],
    ['no schemaVersion', '{"count":7}'],
    ['JSON that is not an object', 'null'],
  ])('rejects %s with CorruptStateError and leaves the file untouched', async (_case, content) => {
    await (await openCounter()).update(increment);
    await writeFile(path, content);

    await expect(openCounter()).rejects.toThrow(CorruptStateError);

    expect(await readFile(path, 'utf8')).toBe(content);
    expect(await readdir(directory)).toEqual(['state.json']);
  });
});

describe('update', () => {
  it('writes the new state and returns it from read()', async () => {
    const store = await openCounter();

    await store.update(increment);

    expect(await onDisk()).toEqual({ schemaVersion: 1, count: 1 });
    expect(await store.read()).toEqual({ schemaVersion: 1, count: 1 });
    // The temporary file was renamed over the target: nothing else is left behind.
    expect(await readdir(directory)).toEqual(['state.json']);
  });

  it('writes nothing for UNCHANGED, and discards what the mutator edited in place', async () => {
    const store = await openCounter();
    await store.update(increment);
    const { ino } = await stat(path);

    await store.update((state) => {
      state.count = 99;
      return UNCHANGED;
    });

    expect(await store.read()).toEqual({ schemaVersion: 1, count: 1 });
    // Every write replaces the file by a rename, which gives it a new inode.
    expect((await stat(path)).ino).toBe(ino);
  });

  it('keeps state and file when the write fails, and commits the next update', async () => {
    const store = await openCounter();
    await store.update(increment);
    vi.mocked(writeFileAtomic).mockRejectedValueOnce(new Error('disk full'));

    await expect(
      store.update((state) => {
        state.count = 99;
        return state;
      }),
    ).rejects.toThrow('disk full');

    expect(await store.read()).toEqual({ schemaVersion: 1, count: 1 });
    expect(await onDisk()).toEqual({ schemaVersion: 1, count: 1 });

    await store.update(increment);
    expect(await onDisk()).toEqual({ schemaVersion: 1, count: 2 });
  });

  it('keeps state and file when the mutator throws, and commits the next update', async () => {
    const store = await openCounter();
    await store.update(increment);

    await expect(
      store.update((state) => {
        state.count = 99;
        throw new Error('refused');
      }),
    ).rejects.toThrow('refused');

    expect(await store.read()).toEqual({ schemaVersion: 1, count: 1 });
    await store.update(increment);
    expect(await onDisk()).toEqual({ schemaVersion: 1, count: 2 });
  });

  it('runs updates one at a time: none of 100 concurrent increments is lost', async () => {
    const store = await openCounter();
    const seen: number[] = [];

    await Promise.all(
      Array.from({ length: 100 }, () =>
        store.update((state) => {
          seen.push(state.count);
          return increment(state);
        }),
      ),
    );

    // Each mutator saw the state the one before it had committed.
    expect(seen).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(await onDisk()).toEqual({ schemaVersion: 1, count: 100 });
  });
});
