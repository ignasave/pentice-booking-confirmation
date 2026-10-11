import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeTempDir, readJsonFile } from '../../../tests/helpers';
import { createBooking, openBookingStore, randomCode } from './bookings';
import type { Booking } from './bookings';

const ANA = { reservationId: 'R123', guest: 'ana@example.com' };

/** The store, plus the bookings on disk and a way to tell whether the file was rewritten. */
async function openStore() {
  const dataDir = await makeTempDir();
  const path = join(dataDir, 'bookings.json');
  return {
    dataDir,
    store: await openBookingStore(dataDir),
    onDisk: async () => (await readJsonFile<{ bookings: Booking[] }>(path)).bookings,
    // Every write replaces the file by a rename, which gives it a new inode.
    inode: async () => (await stat(path)).ino,
  };
}

/** Hands out `codes` in order. */
const codesInOrder = (...codes: string[]) => vi.fn(() => codes.shift() ?? 'zzzzz');

describe('confirmation codes', () => {
  it('are 5 characters of [a-z0-9]', () => {
    for (let i = 0; i < 1_000; i += 1) expect(randomCode()).toMatch(/^[a-z0-9]{5}$/);
  });

  it('draws again when the code is taken (forced collision)', async () => {
    const { store, onDisk } = await openStore();
    await createBooking(store, ANA, 10, () => 'aaaaa');
    const generateCode = codesInOrder('aaaaa', 'aaaaa', 'bbbbb');

    const { booking } = await createBooking(
      store,
      { ...ANA, reservationId: 'R2' },
      10,
      generateCode,
    );

    expect(booking.confirmationCode).toBe('bbbbb');
    expect(generateCode).toHaveBeenCalledTimes(3);
    expect((await onDisk()).map((b) => b.confirmationCode)).toEqual(['aaaaa', 'bbbbb']);
  });

  it('fails with 503 CODE_SPACE_EXHAUSTED after codeMaxAttempts taken codes, writing nothing', async () => {
    const { store, onDisk } = await openStore();
    await createBooking(store, ANA, 10, () => 'aaaaa');
    const generateCode = vi.fn(() => 'aaaaa');

    await expect(
      createBooking(store, { ...ANA, reservationId: 'R2' }, 3, generateCode),
    ).rejects.toMatchObject({ statusCode: 503, code: 'CODE_SPACE_EXHAUSTED' });

    expect(generateCode).toHaveBeenCalledTimes(3);
    expect(await onDisk()).toHaveLength(1);
  });
});
describe('createBooking', () => {
  it('stores a booking with a pending delivery', async () => {
    const { store, onDisk } = await openStore();

    const { booking, created } = await createBooking(store, ANA, 10);

    expect(created).toBe(true);
    expect(booking).toMatchObject({
      ...ANA,
      delivery: { status: 'pending', attempts: 0, acknowledgedAt: null, needsAttention: false },
    });
    expect(await onDisk()).toEqual([booking]);
  });

  it('returns the existing booking for a replay and writes nothing', async () => {
    const { store, inode } = await openStore();
    const first = await createBooking(store, ANA, 10);
    const before = await inode();

    const replay = await createBooking(store, ANA, 10);

    expect(replay).toEqual({ booking: first.booking, created: false });
    expect(await inode()).toBe(before);
  });

  it('refuses the same reservation for a different guest with 409 RESERVATION_CONFLICT', async () => {
    const { store, onDisk } = await openStore();
    await createBooking(store, ANA, 10);

    await expect(
      createBooking(store, { ...ANA, guest: 'bob@example.com' }, 10),
    ).rejects.toMatchObject({ statusCode: 409, code: 'RESERVATION_CONFLICT' });
    expect(await onDisk()).toMatchObject([{ guest: 'ana@example.com' }]);
  });

  it('commits nothing when the write fails, and works again once the disk does', async () => {
    const { store, dataDir, onDisk } = await openStore();
    await createBooking(store, ANA, 10);

    // With the directory gone the temporary file of the next write cannot be created.
    await rm(dataDir, { recursive: true });
    await expect(createBooking(store, { ...ANA, reservationId: 'R2' }, 10)).rejects.toMatchObject({
      statusCode: 503,
      code: 'PERSISTENCE_UNAVAILABLE',
    });
    // A replay needs no write, so it is still answered.
    expect((await createBooking(store, ANA, 10)).created).toBe(false);

    await mkdir(dataDir);

    expect((await createBooking(store, { ...ANA, reservationId: 'R2' }, 10)).created).toBe(true);
    expect((await onDisk()).map((b) => b.reservationId)).toEqual(['R123', 'R2']);
  });
});
