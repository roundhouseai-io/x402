import { createRequire } from 'node:module';
import { isJsonObject, isString, type JsonValue } from './core/json.js';

const require = createRequire(import.meta.url);

/** Read from package.json so `--version` cannot drift from the published tag. */
const pkg: JsonValue = require('../package.json');
export const VERSION = isJsonObject(pkg) && isString(pkg.version) ? pkg.version : '0.0.0-unknown';
