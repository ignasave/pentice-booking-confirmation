import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { FastifyError } from '@fastify/error';
import { customAlphabet } from 'nanoid';
import { openJsonFileStore, UNCHANGED } from '@pentice/shared/json-file-store';
import type { JsonFileStore } from '@pentice/shared/json-file-store';
import { CodeSpaceExhausted, PersistenceUnavailable, ReservationConflict } from './errors';

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
