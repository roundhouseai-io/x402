import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Read from package.json so `--version` cannot drift from the published tag. */
export const VERSION: string = (require('../package.json') as { version: string }).version;
