import { readFileSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  bookingConfig,
  eventually,
  makeTempDir,
  postJson,
  SILENT,
  sleep,
  startStub,
} from '../../../tests/helpers';
import type { StubRequest } from '../../../tests/helpers';
import type { Booking } from './bookings';
import type { Config } from './config';
import type { DeliveryPayload } from '@pentice/shared/delivery-payload';
import { startBookingService } from './server';

const ANA = { reservationId: 'R123', guest: 'ana@example.com' };
/** Several backoff periods: the wait between two attempts is below 40 ms. */
const SEVERAL_BACKOFF_PERIODS_MS = 200;

type GuestHandler = (payload: DeliveryPayload, response: ServerResponse, call: number) => void;

/**
 * The real booking service with its delivery timers (10 to 40 ms backoff) in front of a
 * stub guest that answers each delivery with `onDelivery`. `stored` is what the data
 * directory already holds when the service starts.
 */
async function startWithGuest(
  onDelivery: GuestHandler,
  overrides: Partial<Config> = {},
  stored?: object[],
) {
  const guest = await startStub((request: StubRequest, response) =>
    onDelivery(JSON.parse(request.body) as DeliveryPayload, response, guest.requests.length),
  );
  const dataDir = await makeTempDir();
  const path = join(dataDir, 'bookings.json');
  if (stored) writeFileSync(path, JSON.stringify({ schemaVersion: 1, bookings: stored }));
  const service = await startBookingService(
    bookingConfig(dataDir, { GUEST_WEBHOOK_URL: guest.url, ...overrides }),
    SILENT,
  );
  // The guest goes first, so that a request it never answered does not hold up the close.
  onTestFinished(() => guest.close().then(() => service.close()));
  return {
    url: service.url,
    close: () => service.close(),
    deliveries: guest.requests,
    /** Read synchronously: the state on disk at this very instant. */
    onDisk: () => (JSON.parse(readFileSync(path, 'utf8')) as { bookings: Booking[] }).bookings,
    acknowledge: ({ deliveryId, ackToken }: DeliveryPayload) =>
      fetch(`${service.url}/deliveries/${deliveryId}/ack`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ackToken}` },
      }),
  };
}

const answer =
  (status: number): GuestHandler =>
  (_payload, response) => {
    response.writeHead(status).end();
  };
const neverAnswer: GuestHandler = () => {};
describe('delivery', () => {
  it('sends a new booking to the guest at once, without waiting for any interval', async () => {
    // A minute of backoff: only an attempt that waits for nothing arrives in time.
    const system = await startWithGuest(answer(202), {
      BACKOFF_BASE_MS: 60_000,
      BACKOFF_CAP_MS: 60_000,
    });

    await postJson(`${system.url}/bookings`, ANA);

    await eventually(() => expect(system.deliveries).toHaveLength(1));
    expect(system.deliveries[0]?.path).toBe('/inbox');
  });

  it('saves the attempt before the request is sent', async () => {
    const attemptsOnDiskAtRequest: number[] = [];
    const system = await startWithGuest((_payload, response) => {
      attemptsOnDiskAtRequest.push(system.onDisk()[0]!.delivery.attempts);
      response.writeHead(503).end();
    });

    await postJson(`${system.url}/bookings`, ANA);
    await eventually(() => expect(system.deliveries.length).toBeGreaterThanOrEqual(3));

    expect(attemptsOnDiskAtRequest.slice(0, 3)).toEqual([1, 2, 3]);
  });

  it('sends the identical payload on every retry', async () => {
    const system = await startWithGuest(answer(503));

    await postJson(`${system.url}/bookings`, ANA);
    await eventually(() => expect(system.deliveries.length).toBeGreaterThanOrEqual(4));

    const [stored] = system.onDisk();
    expect(stored?.delivery.status).toBe('pending');
    expect(new Set(system.deliveries.map((d) => d.body)).size).toBe(1);
    expect(JSON.parse(system.deliveries[0]!.body)).toEqual({
      deliveryId: stored?.delivery.deliveryId,
      confirmationCode: stored?.confirmationCode,
      reservationId: 'R123',
      guest: 'ana@example.com',
      ackToken: stored?.delivery.ackToken,
    });
  });
  it('sends nothing more after the ACK, and until then a 2xx does not end the retries', async () => {
    const system = await startWithGuest((payload, response, call) => {
      if (call < 3) response.writeHead(202).end();
      // The third copy is acknowledged before it is answered, so no fourth can be under way.
      else void system.acknowledge(payload).then(() => response.writeHead(202).end());
    });

    await postJson(`${system.url}/bookings`, ANA);
    await eventually(() => expect(system.deliveries).toHaveLength(3));
    await sleep(SEVERAL_BACKOFF_PERIODS_MS);

    expect(system.deliveries).toHaveLength(3);
    expect(system.onDisk()).toMatchObject([{ delivery: { status: 'acknowledged', attempts: 3 } }]);
  });

  it.each([
    ['fails', {}, (response: ServerResponse) => response.writeHead(500).end()],
    ['times out', { DELIVERY_TIMEOUT_MS: 30 }, () => {}],
  ])(
    'does not undo an ACK that arrives while a send is in flight when that send %s',
    async (_case, overrides, finish) => {
      const system = await startWithGuest((payload, response) => {
        // The guest has stored the confirmation and acknowledges before its answer is due.
        void system.acknowledge(payload).then(() => finish(response));
      }, overrides);

      await postJson(`${system.url}/bookings`, ANA);
      await eventually(() =>
        expect(system.onDisk()).toMatchObject([{ delivery: { status: 'acknowledged' } }]),
      );
      const [acknowledged] = system.onDisk();
      await sleep(SEVERAL_BACKOFF_PERIODS_MS);

      expect(system.onDisk()).toEqual([acknowledged]);
      expect(system.deliveries).toHaveLength(1);
    },
  );

  it('retries a guest that answers 4xx, and flags needsAttention at the threshold', async () => {
    const seenAtRequest: Pick<Booking['delivery'], 'attempts' | 'needsAttention'>[] = [];
    const system = await startWithGuest(
      (_payload, response) => {
        const { attempts, needsAttention } = system.onDisk()[0]!.delivery;
        seenAtRequest.push({ attempts, needsAttention });
        response.writeHead(400).end();
      },
      { ATTENTION_THRESHOLD: 3 },
    );

    await postJson(`${system.url}/bookings`, ANA);
    await eventually(() => expect(system.deliveries.length).toBeGreaterThanOrEqual(4));

    expect(seenAtRequest.slice(0, 4)).toEqual([
      { attempts: 1, needsAttention: false },
      { attempts: 2, needsAttention: false },
      { attempts: 3, needsAttention: true },
      { attempts: 4, needsAttention: true },
    ]);
    expect(system.onDisk()).toMatchObject([{ delivery: { status: 'pending' } }]);
  });
  it('sends again after a send times out', async () => {
    const system = await startWithGuest(neverAnswer, { DELIVERY_TIMEOUT_MS: 30 });

    await postJson(`${system.url}/bookings`, ANA);

    await eventually(() => expect(system.deliveries.length).toBeGreaterThanOrEqual(3));
  });

  it('lets a booking be created while a send to a slow guest is in flight', async () => {
    const system = await startWithGuest(neverAnswer);
    await postJson(`${system.url}/bookings`, ANA);
    await eventually(() => expect(system.deliveries).toHaveLength(1));

    const response = await postJson(`${system.url}/bookings`, { ...ANA, reservationId: 'R2' });

    expect(response.status).toBe(201);
    expect(system.onDisk()).toHaveLength(2);
  });

  it('sends a pending booking found in the data directory at start, with no new POST', async () => {
    const delivery = { ackToken: 't', attempts: 7, acknowledgedAt: null, needsAttention: false };
    const booking = { ...ANA, confirmationCode: 'abc12', createdAt: '2026-01-01T00:00:00.000Z' };
    const system = await startWithGuest(answer(503), {}, [
      // As an earlier version saved it: the field that is no longer read does no harm.
      {
        ...booking,
        bookingId: 'b1',
        delivery: { ...delivery, deliveryId: 'd1', status: 'pending', nextAttemptAt: 'x' },
      },
      {
        ...booking,
        bookingId: 'b2',
        delivery: { ...delivery, deliveryId: 'd2', status: 'acknowledged' },
      },
    ]);

    await eventually(() => expect(system.deliveries.length).toBeGreaterThanOrEqual(2));

    const sent = system.deliveries.map((d) => (JSON.parse(d.body) as DeliveryPayload).deliveryId);
    expect(new Set(sent)).toEqual(new Set(['d1']));
    expect(system.onDisk()[0]?.delivery.attempts).toBeGreaterThanOrEqual(9);
  });
  it('runs one timer chain per booking: one send in flight, also after a POST replay', async () => {
    // The guest never answers, so one chain has exactly one send out; a second chain would add its own.
    const system = await startWithGuest(neverAnswer);

    await postJson(`${system.url}/bookings`, ANA);
    await eventually(() => expect(system.deliveries).toHaveLength(1));
    expect((await postJson(`${system.url}/bookings`, ANA)).status).toBe(200);
    await sleep(SEVERAL_BACKOFF_PERIODS_MS);

    expect(system.deliveries).toHaveLength(1);
    expect(system.onDisk()).toMatchObject([{ delivery: { attempts: 1 } }]);
  });

  it('leaves no timer running when it stops: nothing is sent after close', async () => {
    const system = await startWithGuest(answer(503));
    await postJson(`${system.url}/bookings`, ANA);
    await eventually(() => expect(system.deliveries.length).toBeGreaterThanOrEqual(2));

    await system.close();
    const sent = system.deliveries.length;
    await sleep(SEVERAL_BACKOFF_PERIODS_MS);

    expect(system.deliveries).toHaveLength(sent);
  });

  it('waits for a send in flight when it stops', async () => {
    let answered = false;
    const system = await startWithGuest((_payload, response) => {
      setTimeout(() => {
        answered = true;
        response.writeHead(202).end();
      }, 100);
    });
    await postJson(`${system.url}/bookings`, ANA);
    await eventually(() => expect(system.deliveries).toHaveLength(1));

    await system.close();

    expect(answered).toBe(true);
  });
});
