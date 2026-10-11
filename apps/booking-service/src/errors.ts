import createError from '@fastify/error';

export const ReservationConflict = createError<[reservationId: string]>(
  'RESERVATION_CONFLICT',
  'Reservation %s already has a booking for a different guest',
  409,
);
export const CodeSpaceExhausted = createError<[attempts: number]>(
  'CODE_SPACE_EXHAUSTED',
  'No unused confirmation code found in %d attempts',
  503,
);
export const PersistenceUnavailable = createError<[{ cause: unknown }]>(
  'PERSISTENCE_UNAVAILABLE',
  'The change could not be saved',
  503,
);
export const InvalidCode = createError(
  'INVALID_CODE',
  'A confirmation code is 5 characters, each a lowercase letter or a digit',
  400,
);
// The messages name no code and no token: Fastify logs the message of an error it answers.
export const BookingNotFound = createError(
  'BOOKING_NOT_FOUND',
  'No booking has that confirmation code',
  404,
);
export const Unauthorized = createError(
  'UNAUTHORIZED',
  'A valid ack token is required as a Bearer credential',
  401,
);
export const DeliveryNotFound = createError('DELIVERY_NOT_FOUND', 'No delivery has that id', 404);
