import { z } from 'zod';

const nonEmptyString = z.string().min(1);

/** What the booking service posts to the guest's `/inbox`, identical on every attempt of one delivery. */
export const deliveryPayloadSchema = z.object({
  deliveryId: nonEmptyString,
  confirmationCode: nonEmptyString,
  reservationId: nonEmptyString,
  guest: nonEmptyString,
  ackToken: nonEmptyString,
});

export type DeliveryPayload = z.infer<typeof deliveryPayloadSchema>;
