import createError from '@fastify/error';

export const GuestOffline = createError('GUEST_OFFLINE', 'The guest device is offline', 503);
export const DeliveryConflict = createError<[deliveryId: string]>(
  'DELIVERY_CONFLICT',
  'Delivery %s is already stored with different content',
  409,
);
