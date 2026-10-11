import { describe, expect, it } from 'vitest';
import { eventually } from '../helpers';
import { SCENARIO_TIMEOUT_MS, startSystem } from './harness';

const BOOKING = { reservationId: 'R123', guest: 'ana@example.com' };

/**
 * Losing one ACK would leave a race in the restart scenarios: the next copy could be
 * acknowledged before the restart, and the scenario would pass without the restart having
 * mattered. Losing all of them keeps the delivery pending until the test decides otherwise.
 */
const EVERY_ACK = Number.MAX_SAFE_INTEGER;

type System = Awaited<ReturnType<typeof startSystem>>;

const acknowledged = (system: System) =>
  eventually(async () => expect((await system.deliveryOnDisk())?.status).toBe('acknowledged'));

/** Resolves with the single inbox entry once the guest has stored the confirmation. */
const received = (system: System) =>
  eventually(async () => {
    const entries = await system.inbox();
    expect(entries).toHaveLength(1);
    return entries;
  });

describe('booking service and guest simulator together', { timeout: SCENARIO_TIMEOUT_MS }, () => {
  it('happy path', async () => {
    const system = await startSystem();

    expect((await system.createBooking(BOOKING)).status).toBe(201);
    await acknowledged(system);

    const entries = await system.inbox();
    expect(entries).toMatchObject([BOOKING]);
    // The client was never given the code: the only way to it is the guest's inbox.
    const code = entries[0]?.confirmationCode;
    // Retried: the file is replaced an instant before the service swaps the state it
    // answers from, so the API can trail the file the wait above was reading.
    await eventually(async () => {
      const lookup = await fetch(`${system.bookingUrl}/${code}`);
      expect(lookup.status).toBe(200);
      expect(await lookup.json()).toMatchObject({
        reservationId: 'R123',
        deliveryStatus: 'acknowledged',
      });
    });
  });

  it('offline then online', async () => {
    const system = await startSystem();
    await system.chaos({ offline: true });
    expect((await system.createBooking(BOOKING)).status).toBe(201);

    await eventually(async () =>
      expect((await system.deliveryOnDisk())?.attempts).toBeGreaterThanOrEqual(2),
    );
    // Refused attempts are counted and change nothing else.
    expect((await system.deliveryOnDisk())?.status).toBe('pending');
    expect(await system.inbox()).toEqual([]);

    await system.chaos({ offline: false });

    await acknowledged(system);
    expect(await system.inbox()).toHaveLength(1);
  });

  it('lost ACK', async () => {
    const system = await startSystem();
    await system.chaos({ dropNextAcks: 1 });
    expect((await system.createBooking(BOOKING)).status).toBe(201);
    const stored = await received(system);

    await acknowledged(system);

    // The ACK for the first copy was lost, so only a later copy can have been acknowledged,
    // and the guest must have recognised it: the entry is the one it stored the first time.
    expect((await system.deliveryOnDisk())?.attempts).toBeGreaterThanOrEqual(2);
    expect(await system.inbox()).toEqual(stored);
  });

  // The guest refuses every copy, so no send has succeeded when the server goes down.
  it('server restart before first send', async () => {
    const system = await startSystem();
    await system.chaos({ offline: true });
    expect((await system.createBooking(BOOKING)).status).toBe(201);

    await system.restartBooking();

    expect((await system.deliveryOnDisk())?.status).toBe('pending');
    expect(await system.inbox()).toEqual([]);

    await system.chaos({ offline: false });

    await acknowledged(system);
    expect(await system.inbox()).toHaveLength(1);
  });

  it('server restart after guest receipt', async () => {
    const system = await startSystem();
    await system.chaos({ dropNextAcks: EVERY_ACK });
    expect((await system.createBooking(BOOKING)).status).toBe(201);
    const stored = await received(system);

    await system.restartBooking();

    // The new instance knows of the receipt only what the file says: nothing.
    expect((await system.deliveryOnDisk())?.status).toBe('pending');

    await system.chaos({ dropNextAcks: 0 });

    await acknowledged(system);
    expect((await system.deliveryOnDisk())?.deliveryId).toBe(stored[0]?.deliveryId);
    // Same entry, same time of receipt: the copy sent after the restart was not stored again.
    expect(await system.inbox()).toEqual(stored);
  });

  it('guest restart', async () => {
    const system = await startSystem();
    await system.chaos({ dropNextAcks: EVERY_ACK });
    expect((await system.createBooking(BOOKING)).status).toBe(201);
    const stored = await received(system);
    expect((await system.deliveryOnDisk())?.status).toBe('pending');

    // The restart also clears the chaos settings, so the next copy is acknowledged.
    await system.restartGuest();

    await acknowledged(system);
    expect(await system.inbox()).toEqual(stored);
  });
});
