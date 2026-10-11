import { createApp } from '@pentice/shared/create-app';
import { openBookingStore } from './bookings';
import type { Config } from './config';
import { createDelivery } from './delivery';
import { routes } from './routes';

/** `logger` is not an environment variable: only the tests switch the log off. */
export async function startBookingService(
  config: Config,
  { logger = true } = {},
): Promise<{ url: string; close(): Promise<void> }> {
  const store = await openBookingStore(config.DATA_DIR);

  const app = await createApp({
    logger,
    title: 'Booking service',
    description:
      'Creates bookings, resolves confirmation codes and delivers each code to the guest.',
  });
  const delivery =
    config.GUEST_WEBHOOK_URL === undefined
      ? undefined
      : createDelivery(store, config.GUEST_WEBHOOK_URL, config, app.log);
  await app.register(routes, { store, config, startDelivery: delivery?.start });

  const url = await app.listen({ port: config.PORT, host: config.HOST });
  // Only once the server listens, so the ACK endpoint is up before anything is sent.
  await delivery?.resumePending();

  return {
    url,
    async close() {
      await delivery?.stop();
      // The server closes last: an attempt in flight can be acknowledged until it settles.
      await app.close();
    },
  };
}
