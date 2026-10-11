import type { FastifyBaseLogger } from 'fastify';
import { errorResponse } from '@pentice/shared/create-app';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { deliveryPayloadSchema } from '@pentice/shared/delivery-payload';
import type { Config } from './config';
import { GuestOffline } from './errors';
import { listEntries, storeOnce } from './inbox';
import type { Inbox } from './inbox';

const ACK_TIMEOUT_MS = 5_000;
/** `setTimeout` fires at once for a longer delay. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** The faults a test or a person can switch on. In memory: a restart clears them. */
const chaosSchema = z.strictObject({
  /** `POST /inbox` answers 503 and stores nothing. */
  offline: z.boolean(),
  /** How many of the next ACKs are not sent. */
  dropNextAcks: z.int().min(0),
  /** How long an ACK waits after its entry is stored. */
  ackDelayMs: z.int().min(0).max(MAX_TIMER_DELAY_MS),
});

const inboxResponse = z.object({
  // No ack token.
  entries: z.array(
    deliveryPayloadSchema.omit({ ackToken: true }).extend({ receivedAt: z.string() }),
  ),
});

/** The HTTP API: each handler reads the request, calls `inbox.ts` and shapes the response. */
export const routes: FastifyPluginAsyncZod<{ inbox: Inbox; config: Config }> = async (
  app,
  { inbox, config },
) => {
  const chaos: z.infer<typeof chaosSchema> = { offline: false, dropNextAcks: 0, ackDelayMs: 0 };
  const ackTimers = new Set<NodeJS.Timeout>();
  const acksInFlight = new Set<Promise<void>>();

  // Runs once the server has stopped accepting requests: the ACKs still waiting for their
  // delay are cancelled and those being sent are waited for.
  app.addHook('onClose', async () => {
    for (const timer of ackTimers) clearTimeout(timer);
    await Promise.all(acksInFlight);
  });

  app.get(
    '/health',
    {
      schema: {
        summary: 'Liveness check',
        response: { 200: z.object({ status: z.literal('ok') }) },
      },
    },
    () => ({ status: 'ok' as const }),
  );

  app.get(
    '/chaos',
    { schema: { summary: 'Read the fault settings', response: { 200: chaosSchema } } },
    () => chaos,
  );

  app.post(
    '/chaos',
    {
      schema: {
        summary: 'Change any of the fault settings and return all of them',
        body: chaosSchema.partial(),
        response: { 200: chaosSchema, 400: errorResponse },
      },
    },
    (request) => Object.assign(chaos, request.body),
  );

  app.get(
    '/inbox',
    {
      schema: {
        summary: 'List the confirmations received, in order of receipt',
        response: { 200: inboxResponse },
      },
    },
    async () => ({ entries: await listEntries(inbox) }),
  );

  app.post(
    '/inbox',
    {
      schema: {
        summary: 'Receive a confirmation, store it once and acknowledge it',
        body: deliveryPayloadSchema,
        response: {
          202: z.undefined(),
          400: errorResponse,
          409: errorResponse,
          503: errorResponse,
        },
      },
      // Before the body is read: an offline device answers nothing useful to anything.
      onRequest: async () => {
        if (chaos.offline) throw new GuestOffline();
      },
    },
    async (request, reply) => {
      const { deliveryId, ackToken } = request.body;
      await storeOnce(inbox, request.body);
      request.log.info({ deliveryId }, 'Delivery received');

      // Reached only once the entry is on disk, for a duplicate too. The ACK goes out
      // from a timer, after this handler has returned, so it never holds back the 202.
      if (chaos.dropNextAcks > 0) {
        chaos.dropNextAcks -= 1;
      } else {
        const timer = setTimeout(() => {
          ackTimers.delete(timer);
          const ack = sendAck(config.BOOKING_SERVICE_URL, deliveryId, ackToken, app.log);
          acksInFlight.add(ack);
          void ack.finally(() => acksInFlight.delete(ack));
        }, chaos.ackDelayMs);
        ackTimers.add(timer);
      }
      return reply.code(202).send();
    },
  );
};

/**
 * Acknowledges a delivery to the booking service. A failure is logged and dropped: the
 * booking service sends the confirmation again, and that copy is acknowledged then.
 */
async function sendAck(
  bookingServiceUrl: string,
  deliveryId: string,
  ackToken: string,
  log: FastifyBaseLogger,
): Promise<void> {
  const base = bookingServiceUrl.replace(/\/+$/, '');
  try {
    // No body and no Content-Type: Fastify rejects an empty body declared as JSON.
    const response = await fetch(`${base}/deliveries/${encodeURIComponent(deliveryId)}/ack`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ackToken}` },
      signal: AbortSignal.timeout(ACK_TIMEOUT_MS),
    });
    if (!response.ok) {
      log.warn({ deliveryId, status: response.status }, 'ACK rejected by the booking service');
    }
  } catch (error) {
    log.warn({ deliveryId, err: error }, 'ACK could not be sent');
  }
}
