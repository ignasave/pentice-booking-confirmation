import { createApp } from '@pentice/shared/create-app';
import { openBookingStore } from './bookings';
import type { Config } from './config';
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
  await app.register(routes, { store, config });

  const url = await app.listen({ port: config.PORT, host: config.HOST });
  return { url, close: () => app.close() };
}
