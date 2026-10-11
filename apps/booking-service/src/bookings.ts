import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { FastifyError } from '@fastify/error';
import { customAlphabet } from 'nanoid';
import { openJsonFileStore, UNCHANGED } from '@pentice/shared/json-file-store';
import type { JsonFileStore } from '@pentice/shared/json-file-store';
import {
  CodeSpaceExhausted,
  DeliveryNotFound,
  PersistenceUnavailable,
  ReservationConflict,
  Unauthorized,
} from './errors';

interface Delivery {
  /** The same on every attempt; the guest stores a confirmation once per `deliveryId`. */
  deliveryId: string;
  /** The secret the guest presents to acknowledge; it arrives with the confirmation. */
  ackToken: string;
  status: 'pending' | 'acknowledged';
  /** Attempts started. Each is counted and saved before its request is sent. */
  attempts: number;
  acknowledgedAt: string | null;
  needsAttention: boolean;
}

/** A booking and the delivery of its confirmation are one record, written together. */
export interface Booking {
  bookingId: string;
  /** The caller's identifier; repeating a request with the same one creates nothing. */
  reservationId: string;
  guest: string;
  confirmationCode: string;
  createdAt: string;
  delivery: Delivery;
}

interface BookingsState {
  schemaVersion: number;
  bookings: Booking[];
}

export type BookingStore = JsonFileStore<BookingsState>;

export const CODE_PATTERN = /^[a-z0-9]{5}$/;
/** 36^5, about 60 million codes. Uniqueness comes from the check in `createBooking`. */
export const randomCode = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 5);

export function openBookingStore(dataDir: string): Promise<BookingStore> {
  return openJsonFileStore<BookingsState>(join(dataDir, 'bookings.json'), {
    schemaVersion: 1,
    bookings: [],
  });
}

/** Exponential backoff with full jitter: a random delay below `min(capMs, baseMs * 2^attempts)`. */
export function backoffDelayMs(attempts: number, baseMs: number, capMs: number): number {
  return Math.floor(Math.random() * Math.min(capMs, baseMs * 2 ** attempts));
}

/**
 * Runs one store update. The store runs updates one at a time and each mutator works on a
 * copy that replaces the file only if the write succeeds, so a mutator is an atomic
 * check-and-write. A mutator that returns `UNCHANGED` writes nothing.
 */
async function update(
  store: BookingStore,
  mutator: (state: BookingsState) => BookingsState | typeof UNCHANGED,
): Promise<void> {
  try {
    await store.update(mutator);
  } catch (error) {
    // A refusal thrown by the mutator passes through; anything else is a write that failed.
    if (error instanceof FastifyError) throw error;
    throw new PersistenceUnavailable({ cause: error });
  }
}

function unusedCode(bookings: Booking[], maxAttempts: number, generateCode: () => string): string {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const code = generateCode();
    if (!bookings.some((b) => b.confirmationCode === code)) return code;
  }
  throw new CodeSpaceExhausted(maxAttempts);
}

/**
 * Creates the booking for a reservation, with its pending delivery, or returns the one the
 * reservation already has. `generateCode` exists so that a test can force a collision.
 */
export async function createBooking(
  store: BookingStore,
  request: { reservationId: string; guest: string },
  codeMaxAttempts: number,
  generateCode: () => string = randomCode,
): Promise<{ booking: Booking; created: boolean }> {
  // Assigned by the mutator, which has run by the time the update resolves.
  let result!: { booking: Booking; created: boolean };

  // The reservation lookup, the code check and the insert share one update: two requests
  // can neither take the same code nor both create a booking for one reservation.
  await update(store, (state) => {
    const existing = state.bookings.find((b) => b.reservationId === request.reservationId);
    if (existing) {
      if (existing.guest !== request.guest) throw new ReservationConflict(request.reservationId);
      result = { booking: existing, created: false };
      return UNCHANGED;
    }

    const now = new Date().toISOString();
    const booking: Booking = {
      bookingId: randomUUID(),
      reservationId: request.reservationId,
      guest: request.guest,
      confirmationCode: unusedCode(state.bookings, codeMaxAttempts, generateCode),
      createdAt: now,
      delivery: {
        deliveryId: randomUUID(),
        ackToken: randomBytes(32).toString('base64url'),
        status: 'pending',
        attempts: 0,
        acknowledgedAt: null,
        needsAttention: false,
      },
    };
    state.bookings.push(booking);
    result = { booking, created: true };
    return state;
  });
  return result;
}

export async function findByCode(store: BookingStore, code: string): Promise<Booking | undefined> {
  return (await store.read()).bookings.find((b) => b.confirmationCode === code);
}

export async function listBookings(store: BookingStore): Promise<Booking[]> {
  return (await store.read()).bookings;
}

// `timingSafeEqual` throws on inputs of different lengths, so the length is compared first.
// That reveals only the length, which is the same for every token.
function sameToken(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Ends a delivery for whoever holds its ack token. This is the only place a delivery
 * becomes `acknowledged`. Repeating it succeeds and writes nothing.
 */
export async function acknowledgeDelivery(
  store: BookingStore,
  deliveryId: string,
  presentedToken: string | undefined,
): Promise<void> {
  // Before the lookup, so a request without a token cannot learn whether a delivery exists.
  if (presentedToken === undefined) throw new Unauthorized();

  await update(store, (state) => {
    const delivery = state.bookings.find((b) => b.delivery.deliveryId === deliveryId)?.delivery;
    if (!delivery) throw new DeliveryNotFound();
    if (!sameToken(presentedToken, delivery.ackToken)) throw new Unauthorized();
    if (delivery.status === 'acknowledged') return UNCHANGED;
    delivery.status = 'acknowledged';
    delivery.acknowledgedAt = new Date().toISOString();
    return state;
  });
}

/**
 * Counts one delivery attempt, before its request is sent, and returns the booking to send.
 * Returns nothing and writes nothing when the booking is unknown or already acknowledged:
 * that is where retrying ends.
 */
export async function countAttempt(
  store: BookingStore,
  bookingId: string,
  attentionThreshold: number,
): Promise<Booking | undefined> {
  let counted: Booking | undefined;

  // The status check and the count share one update, so an ACK is either saved before it,
  // and nothing is counted, or after it, and the ACK still wins.
  await update(store, (state) => {
    const booking = state.bookings.find((b) => b.bookingId === bookingId);
    if (!booking || booking.delivery.status === 'acknowledged') return UNCHANGED;
    booking.delivery.attempts += 1;
    // Never cleared: the flag records that the threshold was crossed.
    booking.delivery.needsAttention ||= booking.delivery.attempts >= attentionThreshold;
    counted = booking;
    return state;
  });
  return counted;
}
