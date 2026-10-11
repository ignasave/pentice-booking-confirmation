import { z } from 'zod';

/** Up to the longest delay `setTimeout` accepts; a longer one fires at once. */
const positiveInt = z.coerce.number().int().min(1).max(2_147_483_647);

/** The environment variables the service reads, with their defaults. */
export const configSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65_535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  /** Directory of `bookings.json`. */
  DATA_DIR: z.string().default('./data'),
  /** Candidate codes one booking may draw before it fails with CODE_SPACE_EXHAUSTED. */
  CODE_MAX_ATTEMPTS: positiveInt.default(10),
});

export type Config = z.infer<typeof configSchema>;
