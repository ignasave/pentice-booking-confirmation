import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';
import { startBookingService } from '@pentice/booking-service/server';
import { startGuestSimulator } from '@pentice/guest-simulator/server';
import type { DeliveryPayload } from '@pentice/shared/delivery-payload';
import { bookingConfig, makeTempDir, postJson, readJsonFile, SILENT } from '../helpers';

const HOST = '127.0.0.1';

/** Room for the two `eventually` waits of a scenario; Vitest's default allows a single one. */
export const SCENARIO_TIMEOUT_MS = 15_000;

/** The part of a `bookings.json` record that the scenarios observe. */
interface PersistedBooking {
  delivery: { deliveryId: string; status: 'pending' | 'acknowledged'; attempts: number };
}

type InboxEntry = Omit<DeliveryPayload, 'ackToken'> & { receivedAt: string };

/** Binds a free port and keeps it bound, so that nothing else is given it, until `release()`. */
async function reservePort() {
  const holder = createServer();
  await new Promise<void>((resolve) => holder.listen(0, HOST, resolve));
  const { port } = holder.address() as AddressInfo;
  return {
    port,
    release: () => new Promise<void>((resolve) => holder.close(() => resolve())),
  };
}

/**
 * Starts both services as they run in production, talking over HTTP on loopback and
 * persisting to real files, with retries fast enough for a test to watch several of them
 * (20 to 100 ms backoff). Both are closed when the test ends.
 */
export async function startSystem() {
  const [bookingDir, guestDir] = [await makeTempDir(), await makeTempDir()];

  // Each service is configured with the other's address, so one address has to be known
  // before its server exists. The port stays bound while the simulator picks its own.
  const reserved = await reservePort();
  const bookingUrl = `http://${HOST}:${reserved.port}`;

  const startGuest = (port: number) =>
    startGuestSimulator(
      { PORT: port, HOST, DATA_DIR: guestDir, BOOKING_SERVICE_URL: bookingUrl },
      SILENT,
    );
  let guest = await startGuest(0);
  const guestUrl = guest.url;

  const startBooking = () =>
    startBookingService(
      bookingConfig(bookingDir, {
        PORT: reserved.port,
        GUEST_WEBHOOK_URL: guestUrl,
        BACKOFF_BASE_MS: 20,
        BACKOFF_CAP_MS: 100,
      }),
      SILENT,
    );
  await reserved.release();
  let booking = await startBooking();

  onTestFinished(async () => {
    await Promise.all([booking.close(), guest.close()]);
  });

  return {
    bookingUrl,

    createBooking: (body: { reservationId: string; guest: string }) =>
      postJson(`${bookingUrl}/bookings`, body),

    /** What the guest holds, as its own API reports it. */
    async inbox(): Promise<InboxEntry[]> {
      const response = await fetch(`${guestUrl}/inbox`);
      return ((await response.json()) as { entries: InboxEntry[] }).entries;
    },

    async chaos(update: { offline?: boolean; dropNextAcks?: number }): Promise<void> {
      const response = await postJson(`${guestUrl}/chaos`, update);
      if (!response.ok) throw new Error(`POST /chaos answered ${response.status}`);
    },

    /** Read from disk rather than through the API: this is the state a restart resumes from. */
    async deliveryOnDisk(): Promise<PersistedBooking['delivery'] | undefined> {
      const path = join(bookingDir, 'bookings.json');
      return (await readJsonFile<{ bookings: PersistedBooking[] }>(path)).bookings[0]?.delivery;
    },

    /** A new instance on the same port and data directory; nothing is carried over in memory. */
    async restartBooking(): Promise<void> {
      await booking.close();
      booking = await startBooking();
    },

    /** As above for the simulator. Its chaos settings live in memory, so they are reset. */
    async restartGuest(): Promise<void> {
      await guest.close();
      guest = await startGuest(Number(new URL(guestUrl).port));
    },
  };
}
