import { join } from 'node:path';
import type { DeliveryPayload } from '@pentice/shared/delivery-payload';
import { openJsonFileStore, UNCHANGED } from '@pentice/shared/json-file-store';
import type { JsonFileStore } from '@pentice/shared/json-file-store';
import { DeliveryConflict } from './errors';

export interface InboxEntry extends DeliveryPayload {
  receivedAt: string;
}

interface InboxState {
  schemaVersion: number;
  /** Keyed by `deliveryId`: the entries are also the record of what was already received. */
  entries: Record<string, InboxEntry>;
}

export type Inbox = JsonFileStore<InboxState>;

export function openInbox(dataDir: string): Promise<Inbox> {
  return openJsonFileStore<InboxState>(join(dataDir, 'inbox.json'), {
    schemaVersion: 1,
    entries: {},
  });
}

/**
 * Stores a confirmation unless its `deliveryId` is already there, and resolves once it is
 * on disk. A repeat of a stored delivery changes nothing and writes nothing.
 */
export async function storeOnce(inbox: Inbox, payload: DeliveryPayload): Promise<void> {
  // The lookup and the insert share one update, and updates run one at a time: copies of
  // a delivery that arrive together cannot both be stored.
  await inbox.update((state) => {
    // An own-property check, so an id such as "constructor" is not mistaken for an entry.
    const existing = Object.hasOwn(state.entries, payload.deliveryId)
      ? state.entries[payload.deliveryId]
      : undefined;
    if (existing) {
      const sameContent =
        existing.confirmationCode === payload.confirmationCode &&
        existing.reservationId === payload.reservationId &&
        existing.guest === payload.guest;
      if (sameContent) return UNCHANGED;
      throw new DeliveryConflict(payload.deliveryId);
    }
    state.entries[payload.deliveryId] = {
      deliveryId: payload.deliveryId,
      confirmationCode: payload.confirmationCode,
      reservationId: payload.reservationId,
      guest: payload.guest,
      ackToken: payload.ackToken,
      receivedAt: new Date().toISOString(),
    };
    return state;
  });
}

/** Entries in order of receipt. With the `ackToken`: the response schema of the route drops it. */
export async function listEntries(inbox: Inbox): Promise<InboxEntry[]> {
  const { entries } = await inbox.read();
  return Object.values(entries).sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
}
