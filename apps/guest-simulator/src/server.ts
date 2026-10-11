import { createApp } from '@pentice/shared/create-app';
import type { Config } from './config';
import { openInbox } from './inbox';
import { routes } from './routes';

/** `logger` is not an environment variable: only the tests switch the log off. */
export async function startGuestSimulator(
  config: Config,
  { logger = true } = {},
): Promise<{ url: string; close(): Promise<void> }> {
  const inbox = await openInbox(config.DATA_DIR);

  const app = await createApp({
    logger,
    title: 'Guest simulator',
    description:
      'Stands in for the guest device: stores each confirmation once and acknowledges it.',
  });
  await app.register(routes, { inbox, config });

  const url = await app.listen({ port: config.PORT, host: config.HOST });
  return { url, close: () => app.close() };
}
