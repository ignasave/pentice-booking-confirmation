import type { FastifyBaseLogger } from 'fastify';
import type { DeliveryPayload } from '@pentice/shared/delivery-payload';
import { backoffDelayMs, countAttempt, listBookings } from './bookings';
import type { Booking, BookingStore } from './bookings';
import type { Config } from './config';

/**
 * Sends each confirmation to the guest again and again until it is acknowledged: send,
 * wait, check, send again. The saved status is the only truth; a timer is just a reminder
 * to look at it, so losing every timer in a crash loses nothing.
 */
export function createDelivery(
  store: BookingStore,
  guestWebhookUrl: string,
  config: Config,
  log: FastifyBaseLogger,
) {
  const inboxUrl = `${guestWebhookUrl.replace(/\/+$/, '')}/inbox`;
  /** The latest timer of every booking that is being delivered: one chain per booking. */
  const timers = new Map<string, NodeJS.Timeout>();
  const inFlight = new Set<Promise<void>>();
  let stopped = false;

  /** `attempt` counts the attempts of this process only; it sets how long the next wait is. */
  function schedule(bookingId: string, attempt: number, delayMs: number): void {
    if (stopped) return;
    const timer = setTimeout(() => {
      const run = deliver(bookingId, attempt).finally(() => inFlight.delete(run));
      inFlight.add(run);
    }, delayMs);
    timers.set(bookingId, timer);
  }

  async function deliver(bookingId: string, attempt: number): Promise<void> {
    try {
      // Saved before anything is sent. Nothing comes back once the guest has acknowledged.
      const booking = await countAttempt(store, bookingId, config.ATTENTION_THRESHOLD);
      if (!booking) {
        timers.delete(bookingId);
        return;
      }
      await sendToGuest(booking);
    } catch (error) {
      log.error({ err: error, bookingId }, 'Delivery attempt could not be saved');
    }
    // Whatever the guest answered: only the saved status, read again then, ends the retries.
    const delayMs = backoffDelayMs(attempt, config.BACKOFF_BASE_MS, config.BACKOFF_CAP_MS);
    schedule(bookingId, attempt + 1, delayMs);
  }

  /** Makes one attempt and logs it. The outcome changes no state, not even a 2xx. Never rejects. */
  async function sendToGuest(booking: Booking): Promise<void> {
    const { bookingId, confirmationCode, reservationId, guest } = booking;
    // `attempt` here is the saved count of the delivery, across restarts.
    const { deliveryId, ackToken, attempts: attempt, needsAttention } = booking.delivery;
    const body: DeliveryPayload = { deliveryId, confirmationCode, reservationId, guest, ackToken };
    const startedAt = Date.now();
    let result: { outcome: 'accepted' | 'rejected' | 'failed'; status?: number; reason?: string };
    try {
      const response = await fetch(inboxUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        // The body carries the ack token, so it goes to the configured address only.
        redirect: 'manual',
        signal: AbortSignal.timeout(config.DELIVERY_TIMEOUT_MS),
      });
      await response.body?.cancel();
      const { status } = response;
      const rejected = status >= 400 && status < 500;
      result = { outcome: response.ok ? 'accepted' : rejected ? 'rejected' : 'failed', status };
    } catch (error) {
      // fetch reports every network error as "fetch failed" and keeps the reason in the cause.
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      const reason = cause instanceof Error ? cause.message : String(cause);
      result = { outcome: 'failed', reason };
    }
    // Identifiers only: a log line never carries the ack token, the code or the guest.
    const durationMs = Date.now() - startedAt;
    const details = { bookingId, deliveryId, attempt, ...result, durationMs, needsAttention };
    if (result.outcome === 'accepted') log.info(details, 'Delivery attempt');
    else log.warn(details, 'Delivery attempt');
  }

  function start(bookingId: string, delayMs = 0): void {
    if (!timers.has(bookingId)) schedule(bookingId, 0, delayMs);
  }

  return {
    start,
    /** After a restart: every pending booking, spread out so they are not sent all at once. */
    async resumePending(): Promise<void> {
      for (const { bookingId, delivery } of await listBookings(store)) {
        if (delivery.status === 'pending') start(bookingId, Math.random() * config.BACKOFF_BASE_MS);
      }
    },
    /** Clears every timer and resolves once the attempts in flight have settled. */
    async stop(): Promise<void> {
      stopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
      await Promise.all(inFlight);
    },
  };
}
