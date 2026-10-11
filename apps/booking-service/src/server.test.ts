import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import {
  bookingConfig,
  errorCode,
  makeTempDir,
  postJson,
  readJsonFile,
  SILENT,
} from '../../../tests/helpers';
import type { Booking } from './bookings';
import { startBookingService } from './server';

const ANA = { reservationId: 'R123', guest: 'ana@example.com' };

/** A booking service without a guest to deliver to: only the API is under test here. */
async function startService() {
  const dataDir = await makeTempDir();
  const service = await startBookingService(bookingConfig(dataDir), SILENT);
  onTestFinished(() => service.close());
  return {
    url: service.url,
    dataDir,
    onDisk: async () =>
      (await readJsonFile<{ bookings: Booking[] }>(join(dataDir, 'bookings.json'))).bookings,
  };
}

describe('POST /bookings', () => {
  it('answers 201 without the confirmation code in the body or the headers', async () => {
    const { url, onDisk } = await startService();

    const response = await postJson(`${url}/bookings`, ANA);
    const text = await response.text();
    const [stored] = await onDisk();

    expect(response.status).toBe(201);
    expect(JSON.parse(text)).toEqual({
      bookingId: stored?.bookingId,
      reservationId: 'R123',
      deliveryStatus: 'pending',
    });
    for (const secret of [stored!.confirmationCode, stored!.delivery.ackToken]) {
      expect(text).not.toContain(secret);
      expect([...response.headers.values()].join('\n')).not.toContain(secret);
    }
  });

  it('answers 200 with the same bookingId for a replay, and 409 for another guest', async () => {
    const { url, onDisk } = await startService();
    const first = (await (await postJson(`${url}/bookings`, ANA)).json()) as { bookingId: string };

    const replay = await postJson(`${url}/bookings`, ANA);
    const conflict = await postJson(`${url}/bookings`, { ...ANA, guest: 'bob@example.com' });

    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      ...first,
      reservationId: 'R123',
      deliveryStatus: 'pending',
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      statusCode: 409,
      code: 'RESERVATION_CONFLICT',
      error: 'Conflict',
      message: 'Reservation R123 already has a booking for a different guest',
    });
    expect(await onDisk()).toHaveLength(1);
  });

  it.each([
    ['no guest', { reservationId: 'R1' }],
    ['a guest that is not an email address', { reservationId: 'R1', guest: 'ana' }],
    ['an empty reservationId', { reservationId: '', guest: 'ana@example.com' }],
    ['a reservationId that is not a string', { reservationId: 123, guest: 'ana@example.com' }],
    ['a reservationId over 64 characters', { reservationId: 'R'.repeat(65), guest: 'a@b.co' }],
    ['a guest over 254 characters', { reservationId: 'R1', guest: `${'a'.repeat(250)}@b.co` }],
  ])('answers 400 FST_ERR_VALIDATION for %s', async (_case, body) => {
    const { url } = await startService();

    const response = await postJson(`${url}/bookings`, body);

    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe('FST_ERR_VALIDATION');
  });

  it('gives 50 concurrent bookings 50 distinct codes', async () => {
    const { url, onDisk } = await startService();

    const responses = await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        postJson(`${url}/bookings`, { ...ANA, reservationId: `R${i}` }),
      ),
    );

    expect(responses.map((r) => r.status)).toEqual(Array(50).fill(201));
    const codes = (await onDisk()).map((b) => b.confirmationCode);
    expect(new Set(codes).size).toBe(50);
  });

  it('creates one record for 20 concurrent identical requests: one 201 and nineteen 200s', async () => {
    const { url, onDisk } = await startService();

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => postJson(`${url}/bookings`, ANA)),
    );
    const bodies = (await Promise.all(responses.map((r) => r.json()))) as { bookingId: string }[];

    expect(responses.map((r) => r.status).sort()).toEqual([...Array<number>(19).fill(200), 201]);
    expect(new Set(bodies.map((b) => b.bookingId)).size).toBe(1);
    expect(await onDisk()).toHaveLength(1);
  });

  it('answers 503 PERSISTENCE_UNAVAILABLE and commits nothing when the write fails', async () => {
    const { url, dataDir } = await startService();
    // With the directory gone the store cannot create the file it writes before renaming.
    await rm(dataDir, { recursive: true });

    const response = await postJson(`${url}/bookings`, ANA);

    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe('PERSISTENCE_UNAVAILABLE');
  });
});

describe('GET /:code', () => {
  it('returns the booking without its ack token or delivery id', async () => {
    const { url, onDisk } = await startService();
    await postJson(`${url}/bookings`, ANA);
    const [stored] = await onDisk();

    const response = await fetch(`${url}/${stored?.confirmationCode}`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({
      bookingId: stored?.bookingId,
      reservationId: 'R123',
      guest: 'ana@example.com',
      confirmationCode: stored?.confirmationCode,
      createdAt: stored?.createdAt,
      deliveryStatus: 'pending',
    });
    for (const secret of [stored!.delivery.ackToken, stored!.delivery.deliveryId]) {
      expect(text).not.toContain(secret);
    }
  });

  it('answers 404 BOOKING_NOT_FOUND for a well-formed code that no booking has', async () => {
    const { url } = await startService();

    const response = await fetch(`${url}/zzzz9`);

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe('BOOKING_NOT_FOUND');
  });

  it.each(['ABCDE', 'abcd', 'abcdef', 'ab-de', 'bookings', ''])(
    'answers 400 INVALID_CODE for the malformed code "%s"',
    async (code) => {
      const { url } = await startService();

      const response = await fetch(`${url}/${code}`);

      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('INVALID_CODE');
    },
  );

  it('answers 404 for a path that is no route', async () => {
    const { url } = await startService();

    const response = await fetch(`${url}/no/such/route`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ statusCode: 404, error: 'Not Found' });
  });
});

describe('GET /docs', () => {
  it('serves Swagger UI and an OpenAPI document that lists every route', async () => {
    const { url } = await startService();

    const ui = await fetch(`${url}/docs`);
    const openapi = (await (await fetch(`${url}/docs/json`)).json()) as { paths: object };

    expect(ui.status).toBe(200);
    expect(Object.keys(openapi.paths).sort()).toEqual(['/bookings', '/health', '/{code}']);
  });
});

describe('GET /health', () => {
  it('answers 200', async () => {
    const { url } = await startService();

    expect(await (await fetch(`${url}/health`)).json()).toEqual({ status: 'ok' });
  });
});
