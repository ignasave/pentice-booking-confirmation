import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  errorCode,
  eventually,
  makeTempDir,
  postJson,
  SILENT,
  sleep,
  startStub,
} from '../../../tests/helpers';
import type { DeliveryPayload } from '@pentice/shared/delivery-payload';
import type { InboxEntry } from './inbox';
import { startGuestSimulator } from './server';

const DELIVERY: DeliveryPayload = {
  deliveryId: 'd-1',
  confirmationCode: 'a2b34',
  reservationId: 'R123',
  guest: 'ana@example.com',
  ackToken: 'secret-token',
};
/** Long enough for an ACK that was going to be sent to have arrived. */
const SETTLE_MS = 100;

/** The simulator in front of a stub booking service that records the ACKs it is sent. */
async function startGuest(dataDir?: string) {
  dataDir ??= await makeTempDir();
  const path = join(dataDir, 'inbox.json');
  const entriesOnDisk = () =>
    (JSON.parse(readFileSync(path, 'utf8')) as { entries: Record<string, InboxEntry> }).entries;
  const idsOnDiskAtAck: string[][] = [];
  const booking = await startStub((_request, response) => {
    idsOnDiskAtAck.push(Object.keys(entriesOnDisk()));
    response.writeHead(204).end();
  });
  const guest = await startGuestSimulator(
    { PORT: 0, HOST: '127.0.0.1', DATA_DIR: dataDir, BOOKING_SERVICE_URL: booking.url },
    SILENT,
  );
  onTestFinished(() => guest.close());
  return {
    url: guest.url,
    dataDir,
    acks: booking.requests,
    idsOnDiskAtAck,
    entriesOnDisk,
    close: () => guest.close(),
    deliver: (payload: unknown = DELIVERY) => postJson(`${guest.url}/inbox`, payload),
    chaos: (settings: unknown) => postJson(`${guest.url}/chaos`, settings),
    inbox: async () =>
      ((await (await fetch(`${guest.url}/inbox`)).json()) as { entries: unknown[] }).entries,
  };
}

describe('POST /inbox', () => {
  it('stores the confirmation, answers 202 and then acknowledges with the ack token', async () => {
    const guest = await startGuest();

    const response = await guest.deliver();

    expect(response.status).toBe(202);
    await eventually(() => expect(guest.acks).toHaveLength(1));
    expect(guest.acks[0]).toMatchObject({
      path: '/deliveries/d-1/ack',
      authorization: 'Bearer secret-token',
    });
    // The inbox lists the entry without its ack token.
    expect(await guest.inbox()).toEqual([
      {
        deliveryId: 'd-1',
        confirmationCode: 'a2b34',
        reservationId: 'R123',
        guest: 'ana@example.com',
        receivedAt: expect.any(String),
      },
    ]);
    expect(await (await fetch(`${guest.url}/inbox`)).text()).not.toContain('secret-token');
  });

  it('acknowledges only after the entry is on disk', async () => {
    const guest = await startGuest();

    await guest.deliver();
    await eventually(() => expect(guest.acks).toHaveLength(1));

    expect(guest.idsOnDiskAtAck).toEqual([['d-1']]);
  });

  it('answers 500 and sends no ACK when the entry cannot be written', async () => {
    const guest = await startGuest();
    // With the directory gone the store cannot create the file it writes before renaming.
    await rm(guest.dataDir, { recursive: true });

    const response = await guest.deliver();
    await sleep(SETTLE_MS);

    expect(response.status).toBe(500);
    expect(guest.acks).toHaveLength(0);
  });

  it('keeps one entry for 10 concurrent deliveries of the same deliveryId', async () => {
    const guest = await startGuest();

    const responses = await Promise.all(Array.from({ length: 10 }, () => guest.deliver()));

    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(202));
    expect(await guest.inbox()).toHaveLength(1);
  });

  it('acknowledges a duplicate again without storing a second entry', async () => {
    const guest = await startGuest();
    await guest.deliver();
    const stored = await guest.inbox();

    const duplicate = await guest.deliver();

    expect(duplicate.status).toBe(202);
    await eventually(() => expect(guest.acks).toHaveLength(2));
    // Same entry, same time of receipt.
    expect(await guest.inbox()).toEqual(stored);
  });

  it('answers 409 DELIVERY_CONFLICT for a known deliveryId with different content, without an ACK', async () => {
    const guest = await startGuest();
    await guest.deliver();
    await eventually(() => expect(guest.acks).toHaveLength(1));
    const stored = await guest.inbox();

    const conflict = await guest.deliver({ ...DELIVERY, confirmationCode: 'zzzzz' });
    await sleep(SETTLE_MS);

    expect(conflict.status).toBe(409);
    expect(await errorCode(conflict)).toBe('DELIVERY_CONFLICT');
    expect(await guest.inbox()).toEqual(stored);
    expect(guest.acks).toHaveLength(1);
  });

  it('answers 400 FST_ERR_VALIDATION for a delivery with a field missing', async () => {
    const guest = await startGuest();

    const response = await guest.deliver({ ...DELIVERY, ackToken: undefined });

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('FST_ERR_VALIDATION');
    expect(await guest.inbox()).toEqual([]);
  });

  it('still recognises a delivery after a restart', async () => {
    const first = await startGuest();
    await first.deliver();
    const stored = await first.inbox();
    await first.close();

    const second = await startGuest(first.dataDir);
    const response = await second.deliver();

    expect(response.status).toBe(202);
    await eventually(() => expect(second.acks).toHaveLength(1));
    expect(await second.inbox()).toEqual(stored);
  });

  it('keeps one entry for 10 concurrent deliveries of the same deliveryId', async () => {
    const guest = await startGuest();

    const responses = await Promise.all(Array.from({ length: 10 }, () => guest.deliver()));

    expect(responses.map((r) => r.status)).toEqual(Array(10).fill(202));
    expect(await guest.inbox()).toHaveLength(1);
  });

  it('acknowledges a duplicate again without storing a second entry', async () => {
    const guest = await startGuest();
    await guest.deliver();
    const stored = await guest.inbox();

    const duplicate = await guest.deliver();

    expect(duplicate.status).toBe(202);
    await eventually(() => expect(guest.acks).toHaveLength(2));
    // Same entry, same time of receipt.
    expect(await guest.inbox()).toEqual(stored);
  });

  it('answers 409 DELIVERY_CONFLICT for a known deliveryId with different content, without an ACK', async () => {
    const guest = await startGuest();
    await guest.deliver();
    await eventually(() => expect(guest.acks).toHaveLength(1));
    const stored = await guest.inbox();

    const conflict = await guest.deliver({ ...DELIVERY, confirmationCode: 'zzzzz' });
    await sleep(SETTLE_MS);

    expect(conflict.status).toBe(409);
    expect(await errorCode(conflict)).toBe('DELIVERY_CONFLICT');
    expect(await guest.inbox()).toEqual(stored);
    expect(guest.acks).toHaveLength(1);
  });

  it('answers 400 FST_ERR_VALIDATION for a delivery with a field missing', async () => {
    const guest = await startGuest();

    const response = await guest.deliver({ ...DELIVERY, ackToken: undefined });

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('FST_ERR_VALIDATION');
    expect(await guest.inbox()).toEqual([]);
  });

  it('still recognises a delivery after a restart', async () => {
    const first = await startGuest();
    await first.deliver();
    const stored = await first.inbox();
    await first.close();

    const second = await startGuest(first.dataDir);
    const response = await second.deliver();

    expect(response.status).toBe(202);
    await eventually(() => expect(second.acks).toHaveLength(1));
    expect(await second.inbox()).toEqual(stored);
  });
});

describe('chaos', () => {
  it('offline: answers 503 GUEST_OFFLINE, stores nothing and sends no ACK', async () => {
    const guest = await startGuest();
    await guest.chaos({ offline: true });

    const response = await guest.deliver();
    await sleep(SETTLE_MS);

    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe('GUEST_OFFLINE');
    expect(await guest.inbox()).toEqual([]);
    expect(guest.acks).toHaveLength(0);

    await guest.chaos({ offline: false });
    expect((await guest.deliver()).status).toBe(202);
  });

  it('dropNextAcks: stores the entry, skips that many ACKs, then acknowledges the next copy', async () => {
    const guest = await startGuest();
    await guest.chaos({ dropNextAcks: 1 });

    const first = await guest.deliver();
    await sleep(SETTLE_MS);

    expect(first.status).toBe(202);
    expect(await guest.inbox()).toHaveLength(1);
    expect(guest.acks).toHaveLength(0);
    expect(await (await fetch(`${guest.url}/chaos`)).json()).toMatchObject({ dropNextAcks: 0 });

    await guest.deliver();
    await eventually(() => expect(guest.acks).toHaveLength(1));
    expect(await guest.inbox()).toHaveLength(1);
  });

  it('ackDelayMs: answers 202 at once and acknowledges after the delay', async () => {
    const guest = await startGuest();
    await guest.chaos({ ackDelayMs: 150 });

    const response = await guest.deliver();

    expect(response.status).toBe(202);
    expect(guest.acks).toHaveLength(0);
    await eventually(() => expect(guest.acks).toHaveLength(1));
  });

  it('close() cancels an ACK that is still waiting for its delay', async () => {
    const guest = await startGuest();
    await guest.chaos({ ackDelayMs: 50 });
    await guest.deliver();

    await guest.close();
    await sleep(SETTLE_MS);

    expect(guest.acks).toHaveLength(0);
  });

  it('merges settings, returns all of them, and rejects one it does not know', async () => {
    const guest = await startGuest();

    const merged = await guest.chaos({ ackDelayMs: 5 });
    const unknown = await guest.chaos({ offlne: true });
    const wrongType = await guest.chaos({ dropNextAcks: '1' });
    const negative = await guest.chaos({ ackDelayMs: -1 });
    const fraction = await guest.chaos({ dropNextAcks: 1.5 });

    expect(await merged.json()).toEqual({ offline: false, dropNextAcks: 0, ackDelayMs: 5 });
    expect(unknown.status).toBe(400);
    expect(wrongType.status).toBe(400);
    expect(negative.status).toBe(400);
    expect(fraction.status).toBe(400);
    expect(await errorCode(wrongType)).toBe('FST_ERR_VALIDATION');
  });
});

describe('other routes', () => {
  it('serves Swagger UI at /docs and an OpenAPI document that lists every route', async () => {
    const guest = await startGuest();

    const ui = await fetch(`${guest.url}/docs`);
    const openapi = (await (await fetch(`${guest.url}/docs/json`)).json()) as {
      paths: Record<string, object>;
    };

    expect(ui.status).toBe(200);
    expect(
      Object.entries(openapi.paths).map(([path, methods]) => [path, Object.keys(methods)]),
    ).toEqual([
      ['/health', ['get']],
      ['/chaos', ['get', 'post']],
      ['/inbox', ['get', 'post']],
    ]);
  });

  it('answers GET /health with 200 and an unknown route with 404', async () => {
    const guest = await startGuest();

    const unknown = await fetch(`${guest.url}/nowhere`);

    expect((await fetch(`${guest.url}/health`)).status).toBe(200);
    expect(unknown.status).toBe(404);
  });
});
