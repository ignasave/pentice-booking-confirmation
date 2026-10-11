import { z } from 'zod';

/** Up to the longest delay `setTimeout` accepts; a longer one fires at once. */
const positiveInt = z.coerce.number().int().min(1).max(2_147_483_647);

/** The environment variables the service reads, with their defaults. */
export const configSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  /** Directory of `bookings.json`. */
  DATA_DIR: z.string().default('./data'),
  /** Base URL of the guest; confirmations are posted to its `/inbox`. Unset: nothing is sent. */
  GUEST_WEBHOOK_URL: z.url({ protocol: /^https?$/ }).optional(),
  /** Candidate codes one booking may draw before it fails with CODE_SPACE_EXHAUSTED. */
  CODE_MAX_ATTEMPTS: positiveInt.default(10),
  /** First retry window; it doubles with every attempt, up to `BACKOFF_CAP_MS`. */
  BACKOFF_BASE_MS: positiveInt.default(1_000),
  BACKOFF_CAP_MS: positiveInt.default(30_000),
  /** How long one attempt waits for the guest to answer. */
  DELIVERY_TIMEOUT_MS: positiveInt.default(5_000),
  /** Attempts after which a delivery is flagged `needsAttention`. */
  ATTENTION_THRESHOLD: positiveInt.default(10),
});

export type Config = z.infer<typeof configSchema>;
