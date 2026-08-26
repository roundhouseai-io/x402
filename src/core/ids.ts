import { randomBytes, createHash } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Monotonic-enough ULID. Sortable by time, unique per call. */
export function ulid(now = Date.now()): string {
  let ts = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i]! % 32];
  return ts + rand;
}

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Hash in the `sha256:<hex>` form used throughout the ledger. */
export function tagged(input: string | Buffer): string {
  return `sha256:${sha256(input)}`;
}

/** 32-byte random hex, 0x-prefixed. Used for EIP-3009 authorization nonces. */
export function randomNonce(): string {
  return `0x${randomBytes(32).toString('hex')}`;
}
