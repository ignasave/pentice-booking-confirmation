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
