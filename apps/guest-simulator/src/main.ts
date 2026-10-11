import closeWithGrace from 'close-with-grace';
import { configSchema } from './config';
import { startGuestSimulator } from './server';

const starting = startGuestSimulator(configSchema.parse(process.env));
// SIGTERM and SIGINT close the service and exit 0; a close that outlasts the delay exits 1.
// Registered before the start has finished, so a signal that arrives during it is not lost.
closeWithGrace({ delay: 10_000 }, async () => (await starting).close());
// A start that fails (a corrupt state file) rejects here: the process prints the error and
// exits non-zero, and the state file is left as it was.
await starting;
