#!/usr/bin/env bash
# Builds both images, starts the stack and checks the one path that needs real containers:
# a booking is delivered to the guest, and it is still resolvable by its code after the
# booking service has been restarted on its volume. Leaves nothing behind.
set -euo pipefail
cd "$(dirname "$0")/.."

BOOKING_URL=http://localhost:3000
GUEST_URL=http://localhost:3001
DEADLINE_SECONDS=60

step() { echo "==> $*"; }

finish() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    echo "FAILED (exit $status); service logs follow" >&2
    docker compose logs --no-color >&2 || true
  fi
  docker compose down -v
  exit "$status"
}
trap finish EXIT

# Runs the command once a second until it succeeds or the deadline passes.
poll() {
  local description=$1
  shift
  local deadline=$((SECONDS + DEADLINE_SECONDS))
  until "$@"; do
    if ((SECONDS >= deadline)); then
      echo "Gave up after ${DEADLINE_SECONDS}s waiting for ${description}" >&2
      return 1
    fi
    sleep 1
  done
}

delivered_code() {
  code=$(curl -fsS "$GUEST_URL/inbox" | sed -n 's/.*"confirmationCode":"\([a-z0-9]\{5\}\)".*/\1/p')
  [[ -n $code ]]
}

booking_is_healthy() { curl -fsS -o /dev/null "$BOOKING_URL/health" 2>/dev/null; }

# Prints the response body and fails unless the status is the expected one.
expect_status() {
  local expected=$1
  shift
  local response status
  response=$(curl -sS -w '\n%{http_code}' "$@")
  status=${response##*$'\n'}
  echo "${response%$'\n'*}"
  if [[ $status != "$expected" ]]; then
    echo "Expected HTTP $expected, got $status" >&2
    return 1
  fi
}

step "Building and starting the stack"
docker compose up --build --wait

step "Creating a booking"
expect_status 201 -X POST "$BOOKING_URL/bookings" \
  -H 'content-type: application/json' \
  -d '{"reservationId":"R123","guest":"ana@example.com"}'

step "Waiting for the confirmation in the guest inbox"
code=''
poll "a confirmation code in $GUEST_URL/inbox" delivered_code
echo "The guest received code $code"

step "Restarting the booking service"
docker compose restart booking-service
poll "the booking service to answer again" booking_is_healthy

step "Resolving the code after the restart"
expect_status 200 "$BOOKING_URL/$code"

echo "PASS"
