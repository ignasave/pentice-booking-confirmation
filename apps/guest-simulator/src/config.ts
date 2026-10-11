import { z } from 'zod';

/** The environment variables the simulator reads, with their defaults. */
export const configSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65_535).default(3001),
  HOST: z.string().default('0.0.0.0'),
  /** Directory of `inbox.json`. */
  DATA_DIR: z.string().default('./data'),
  /** Base URL of the booking service; acknowledgements are posted to it. */
  BOOKING_SERVICE_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:3000'),
});

export type Config = z.infer<typeof configSchema>;
