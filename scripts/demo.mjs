#!/usr/bin/env node
// Walks the running compose stack through the hard cases and checks each one: the guest is
// offline when the booking is made, the booking service restarts before anything was
// delivered, and the first acknowledgement is lost. Start the stack first:
//   docker compose up --build --wait && pnpm demo
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const BOOKING_URL = 'http://localhost:3000';
const GUEST_URL = 'http://localhost:3001';
const POLL_INTERVAL_MS = 500;
const WAIT_DEADLINE_MS = 90_000;
const REQUEST_TIMEOUT_MS = 5_000;
const NO_FAULTS = { offline: false, dropNextAcks: 0, ackDelayMs: 0 };
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let stepNumber = 0;
const step = (title) => console.log(`\n${++stepNumber}. ${title}`);
const detail = (text) => console.log(`   ${text}`);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Sends `body` as a JSON POST, or a GET without one, and reads the answer as text. */
async function request(url, body) {
  try {
    const response = await fetch(url, {
      ...(body !== undefined && {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { status: response.status, headers: response.headers, text: await response.text() };
  } catch (error) {
    // fetch says only "fetch failed"; the reason, such as ECONNREFUSED, is in the cause.
    throw new Error(`No answer from ${url} (${error.cause?.code ?? error.message})`, {
      cause: error,
    });
  }
}

/** The parsed body of an answer that has to be a 200. */
async function getJson(url, body) {
  const { status, text } = await request(url, body);
  assert(status === 200, `Expected 200 from ${url}, got ${status}: ${text}`);
  return JSON.parse(text);
}

/**
 * Calls `probe` every 500 ms until it returns something other than `undefined`. A probe
 * that throws counts as "not yet": a service that is restarting refuses connections.
 */
async function waitFor(description, probe) {
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  let lastFailure = 'the condition was never met';
  for (;;) {
    try {
      const result = await probe();
      if (result !== undefined) return result;
    } catch (error) {
      lastFailure = error.message;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Gave up after ${WAIT_DEADLINE_MS / 1000} s waiting for ${description} (${lastFailure})`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

const setChaos = (settings) => getJson(`${GUEST_URL}/chaos`, settings);

async function inboxEntriesFor(reservationId) {
  const { entries } = await getJson(`${GUEST_URL}/inbox`);
  return entries.filter((entry) => entry.reservationId === reservationId);
}

async function deliveryFor(reservationId) {
  const { deliveries } = await getJson(`${BOOKING_URL}/admin/deliveries`);
  return deliveries.find((delivery) => delivery.reservationId === reservationId);
}

function restartBookingService() {
  const { status, error } = spawnSync('docker', ['compose', 'restart', 'booking-service'], {
    cwd: REPOSITORY_ROOT,
    stdio: 'inherit',
  });
  assert(!error, `docker could not be run: ${error?.message}`);
  assert(status === 0, `docker compose restart booking-service exited with ${status}`);
}

async function runScenario() {
  // Unique, so the script can run again on a stack that still holds earlier bookings.
  const reservationId = `demo-${randomUUID()}`;

  step('Set the guest offline');
  detail(`chaos: ${JSON.stringify(await setChaos({ ...NO_FAULTS, offline: true }))}`);

  step('Create a booking while the guest cannot be reached');
  const created = await request(`${BOOKING_URL}/bookings`, {
    reservationId,
    guest: 'ana@example.com',
  });
  assert(created.status === 201, `Expected 201, got ${created.status}: ${created.text}`);
  detail(`201 ${created.text}`);

  step('Assert the response has no code');
  const booking = JSON.parse(created.text);
  assert(
    Object.keys(booking).sort().join() === 'bookingId,deliveryStatus,reservationId',
    `Unexpected fields in the response: ${Object.keys(booking).join(', ')}`,
  );
  assert(booking.deliveryStatus === 'pending', `Expected pending, got ${booking.deliveryStatus}`);
  detail('fields: bookingId, reservationId, deliveryStatus (checked against the code in step 9)');

  step('Wait for a delivery attempt to fail against the offline guest');
  const refused = await waitFor('a failed delivery attempt', async () => {
    const delivery = await deliveryFor(reservationId);
    return delivery?.attempts >= 1 ? delivery : undefined;
  });
  assert(refused.status === 'pending', `Expected pending, got ${refused.status}`);
  assert((await inboxEntriesFor(reservationId)).length === 0, 'The offline guest stored an entry');
  detail(`status ${refused.status} after ${refused.attempts} attempt(s); guest inbox: 0 entries`);

  step('Restart the booking service with the delivery still pending');
  restartBookingService();
  await waitFor('the booking service to answer /health', async () => {
    const { status } = await request(`${BOOKING_URL}/health`);
    return status === 200 ? true : undefined;
  });
  const restored = await deliveryFor(reservationId);
  assert(restored?.status === 'pending', 'The pending delivery did not survive the restart');
  detail(`healthy again; the delivery is still pending after ${restored.attempts} attempt(s)`);

  step('Set the guest online, with the next acknowledgement dropped');
  detail(`chaos: ${JSON.stringify(await setChaos({ offline: false, dropNextAcks: 1 }))}`);

  step('Wait for the confirmation to reach the guest inbox');
  const [entry] = await waitFor('one inbox entry for the reservation', async () => {
    const entries = await inboxEntriesFor(reservationId);
    return entries.length === 1 ? entries : undefined;
  });
  detail('inbox entries for this reservation: 1');

  step('Wait for the delivery to be acknowledged after the lost acknowledgement');
  const acknowledged = await waitFor('the delivery to be acknowledged', async () => {
    const delivery = await deliveryFor(reservationId);
    return delivery?.status === 'acknowledged' ? delivery : undefined;
  });
  assert(acknowledged.attempts >= 2, `Expected 2 or more attempts, got ${acknowledged.attempts}`);
  const entriesAfter = await inboxEntriesFor(reservationId);
  assert(entriesAfter.length === 1, `Expected 1 inbox entry, found ${entriesAfter.length}`);
  const afterRestart = acknowledged.attempts - restored.attempts;
  detail(
    `status acknowledged after ${acknowledged.attempts} attempts, ${afterRestart} since the restart`,
  );
  detail('inbox entries for this reservation: still 1');

  step('Resolve the code the guest received');
  const code = entry.confirmationCode;
  const responseTexts = [created.text, ...created.headers.values()];
  assert(
    !responseTexts.some((text) => text.includes(code)),
    'The confirmation code appears in the response to POST /bookings',
  );
  const resolved = await getJson(`${BOOKING_URL}/${code}`);
  assert(
    resolved.reservationId === reservationId && resolved.bookingId === booking.bookingId,
    `GET /${code} returned another booking: ${JSON.stringify(resolved)}`,
  );
  detail(`GET /${code} -> 200 ${JSON.stringify(resolved)}`);
  detail('the code was in neither the body nor the headers of the POST /bookings response');
}

async function main() {
  try {
    await runScenario();
    console.log('\nPASS');
  } catch (error) {
    console.error(`\nFAILED at step ${stepNumber}: ${error.message}`);
    process.exitCode = 1;
  }
  // On failure too, so that the stack is not left with a guest that refuses deliveries.
  try {
    await setChaos(NO_FAULTS);
  } catch (error) {
    console.error(`The guest faults could not be reset: ${error.message}`);
    process.exitCode = 1;
  }
}

await main();
