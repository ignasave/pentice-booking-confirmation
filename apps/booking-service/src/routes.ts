import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { errorResponse } from '@pentice/shared/create-app';
import { z } from 'zod';
import { CODE_PATTERN, createBooking, findByCode } from './bookings';
import type { BookingStore } from './bookings';
import type { Config } from './config';
import { BookingNotFound, InvalidCode } from './errors';

const deliveryStatus = z.enum(['pending', 'acknowledged']);

const createBookingBody = z.object({
  reservationId: z.string().min(1).max(64),
  // 254 is the longest address SMTP can route; the format alone sets no limit.
  guest: z.email().max(254),
});
// No confirmation code here, by design: it reaches the guest through delivery only.
const createBookingResponse = z.object({
  bookingId: z.string(),
  reservationId: z.string(),
  deliveryStatus,
});
// No delivery id and no ack token: they must not reach whoever holds a code.
const lookupResponse = z.object({
  bookingId: z.string(),
  reservationId: z.string(),
  guest: z.string(),
  confirmationCode: z.string(),
  createdAt: z.string(),
  deliveryStatus,
});

/** The HTTP API: each handler reads the request, calls `bookings.ts` and shapes the response. */
export const routes: FastifyPluginAsyncZod<{ store: BookingStore; config: Config }> = async (
  app,
  { store, config },
) => {
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

  app.post(
    '/bookings',
    {
      schema: {
        summary: 'Create a booking, or return the one the reservation already has',
        body: createBookingBody,
        response: {
          200: createBookingResponse,
          201: createBookingResponse,
          400: errorResponse,
          409: errorResponse,
          503: errorResponse,
        },
      },
    },
    async (request, reply) => {
      const { booking, created } = await createBooking(
        store,
        request.body,
        config.CODE_MAX_ATTEMPTS,
      );
      if (created) request.log.info({ bookingId: booking.bookingId }, 'Booking created');
      return reply.code(created ? 201 : 200).send({
        bookingId: booking.bookingId,
        reservationId: booking.reservationId,
        deliveryStatus: booking.delivery.status,
      });
    },
  );

  // Matches every single-segment path that no other route claims, so the handler and not
  // the router decides what is a code: a malformed one is a 400, not an unknown route.
  app.get(
    '/:code',
    {
      schema: {
        summary: 'Resolve a confirmation code to its booking',
        params: z.object({ code: z.string() }),
        response: { 200: lookupResponse, 400: errorResponse, 404: errorResponse },
      },
    },
    async (request) => {
      const { code } = request.params;
      if (!CODE_PATTERN.test(code)) throw new InvalidCode();
      const booking = await findByCode(store, code);
      if (!booking) throw new BookingNotFound();
      // The response schema drops every key it does not declare.
      return { ...booking, deliveryStatus: booking.delivery.status };
    },
  );
};
