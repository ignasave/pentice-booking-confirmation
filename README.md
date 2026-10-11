# Booking confirmation delivery

When a guest completes a booking, the service generates a 5-character confirmation code, saves it, and delivers it to the guest out-of-band. The guest's device acknowledges receipt. If it does not, the service keeps sending until it does, and the guest still ends up with exactly one confirmation.

Two small services, written in TypeScript on Fastify:

- **booking-service** (port 3000): `POST /bookings`, `GET /:code`, and the delivery of each confirmation.
- **guest-simulator** (port 3001): plays the guest's device. It stores a confirmation once, acknowledges it, and can be told to go offline or to lose an acknowledgement.

There is no database. Each service keeps its state in one JSON file.

## Run it

Requires Docker.

```sh
docker compose up --build --wait
```

The brief's example:

```sh
# 1. Create a booking. The response has no confirmation code.
curl -X POST localhost:3000/bookings -H 'content-type: application/json' \
  -d '{"reservationId":"R123","guest":"ana@example.com"}'

# 2. The guest received it out-of-band. The code is in the guest's inbox.
curl localhost:3001/inbox

# 3. Resolve the code (replace a2b34 with the code from step 2).
curl localhost:3000/a2b34
```

API docs with every route, request and response: <http://localhost:3000/docs> and <http://localhost:3001/docs>.

Stop it and remove the data with `docker compose down -v`.

### Without Docker

Requires Node 24 and pnpm 10.

```sh
pnpm install
pnpm dev
```

## See the failure cases

With the stack running:

```sh
pnpm demo
```

The script takes the guest offline, creates a booking, restarts the booking service while the delivery is still pending, brings the guest back with its next acknowledgement dropped, and checks that the confirmation arrives exactly once and that the code resolves. It prints each step and ends with `PASS`.

By hand, the guest's faults are set with `POST localhost:3001/chaos`:

```sh
curl -X POST localhost:3001/chaos -H 'content-type: application/json' -d '{"offline":true}'
curl -X POST localhost:3001/chaos -H 'content-type: application/json' -d '{"offline":false,"dropNextAcks":1}'
curl localhost:3000/admin/deliveries
```

`/admin/deliveries` lists every delivery with its status and number of attempts.

## The API

Booking service:

| Route                                     | Answers                                                                                                                                                    |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /bookings` `{reservationId, guest}` | 201 `{bookingId, reservationId, deliveryStatus}`. 200 with the same body when the reservation already has a booking. 409 when it belongs to another guest. |
| `GET /:code`                              | 200 with the booking. 404 for an unknown code, 400 for a malformed one.                                                                                    |
| `POST /deliveries/:deliveryId/ack`        | 204. Requires the delivery's token as `Authorization: Bearer`. Used by the guest.                                                                          |
| `GET /admin/deliveries`                   | Every delivery with status and attempts.                                                                                                                   |
| `GET /health`, `GET /docs`                | Liveness, and the OpenAPI docs.                                                                                                                            |

Guest simulator: `POST /inbox` (receive a confirmation), `GET /inbox`, `GET` and `POST /chaos`, `GET /health`, `GET /docs`.

Errors have the shape `{statusCode, code, error, message}`; `code` is the stable part, for example `BOOKING_NOT_FOUND`.

## The delivery guarantee

- The booking and its pending delivery are saved in one write, before anything is sent.
- The service sends the confirmation, then looks again after a growing, capped delay, and sends again for as long as the delivery is not acknowledged. It never gives up.
- Every attempt carries the same `deliveryId`. The guest stores a confirmation once per `deliveryId` and acknowledges every copy, so a repeated send changes nothing on the guest's side.
- Only the guest's acknowledgement, authenticated with a token that travelled with the confirmation, ends a delivery.
- Pending deliveries resume after a restart, because the saved status is the source of truth and timers are only reminders.

In short: at-least-once sending, exactly one confirmation at the guest. [docs/DESIGN.md](docs/DESIGN.md) has the diagrams, the failure table and the decisions behind this.

## Tests

| Command       | What it runs                                                                           |
| ------------- | -------------------------------------------------------------------------------------- |
| `pnpm verify` | Lint, typecheck and all 97 tests. A few seconds, no Docker.                            |
| `pnpm test`   | The tests alone.                                                                       |
| `pnpm smoke`  | Builds the images, books, restarts the booking service, resolves the code, tears down. |
| `pnpm demo`   | The failure scenario above, against a running stack.                                   |

The tests in `tests/e2e` run both real services together, on real files, through the cases that matter: guest offline then online, a lost acknowledgement, the booking service restarted before and after the guest received the confirmation, and the guest restarted. Each one ends by checking that the delivery is acknowledged and the guest has exactly one entry.

CI runs lint, typecheck, the tests and the smoke test on every push.

## Layout

```
apps/booking-service/src
  bookings.ts    the rules: unique codes, acknowledging, counting attempts
  delivery.ts    one timer per pending delivery
  routes.ts      the HTTP handlers and their schemas
  errors.ts      each refusal and its status code
  server.ts, config.ts, main.ts
apps/guest-simulator/src
  inbox.ts       store once per delivery id
  routes.ts      inbox and fault switches; sends the acknowledgement
packages/shared/src
  json-file-store.ts   one update at a time, atomic writes
  create-app.ts        the Fastify setup both services start from
tests/e2e              both services together
```

About 1,000 lines of source and 1,600 of tests.

## Configuration

Everything has a default. `.env.example` lists every variable.

| Variable                            | Default                 | Meaning                                                        |
| ----------------------------------- | ----------------------- | -------------------------------------------------------------- |
| `PORT`                              | 3000 / 3001             | Port to listen on                                              |
| `DATA_DIR`                          | `./data`                | Directory of the state file                                    |
| `GUEST_WEBHOOK_URL`                 | none                    | Where the booking service delivers. Without it nothing is sent |
| `BOOKING_SERVICE_URL`               | `http://localhost:3000` | Where the guest sends acknowledgements                         |
| `BACKOFF_BASE_MS`, `BACKOFF_CAP_MS` | 1000, 30000             | First retry window and the longest wait between attempts       |
| `DELIVERY_TIMEOUT_MS`               | 5000                    | How long one attempt waits for the guest                       |
| `ATTENTION_THRESHOLD`               | 10                      | Attempts after which a delivery is flagged `needsAttention`    |
| `CODE_MAX_ATTEMPTS`                 | 10                      | Codes a booking may draw before it fails                       |

## Limits

These are deliberate for the size of the exercise.

- **One instance per service.** The lock that makes codes unique lives in one process. Two booking services on the same file would break it.
- **The whole file is rewritten on every change.** Fine for thousands of bookings, not for millions.
- **The code is a lookup key, not a secret.** `GET /:code` has no authentication and no rate limit.
- **Retry timing is kept in memory.** After a restart every pending delivery is sent again promptly and its backoff starts over. There is no cap on simultaneous sends.
- **The channel is simulated.** A real guest would be reached by push or email, with the same protocol behind it.

With a database, the file becomes a table with a unique constraint on the code, the pending delivery becomes an outbox row written in the same transaction as the booking, and the timers become a queue with delayed retries.
