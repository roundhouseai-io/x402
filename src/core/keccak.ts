/**
 * Keccak-256 and the few ABI and EIP-712 encodings the channel schemes need.
 *
 * Node has SHA3-256, which is a different function (the padding differs), and
 * no Keccak-256. The `batch-settlement` channel id is the EIP-712 digest of the
 * channel configuration, and the `auth-capture` nonce is a Keccak hash of the
 * payment info, so both have to be computed here before anything is signed. The
 * CLI has no runtime dependencies on purpose, so this is the one place the hash
 * lives, about eighty lines, pinned by test vectors taken from the reference
 * implementation (test/keccak.test.ts). It signs nothing and holds no secret.
 */

const MASK = (1n << 64n) - 1n;

const RC: readonly bigint[] = [
  0x0000000000000001n,
  0x0000000000008082n,
  0x800000000000808an,
  0x8000000080008000n,
  0x000000000000808bn,
  0x0000000080000001n,
  0x8000000080008081n,
  0x8000000000008009n,
  0x000000000000008an,
  0x0000000000000088n,
  0x0000000080008009n,
  0x000000008000000an,
  0x000000008000808bn,
  0x800000000000008bn,
  0x8000000000008089n,
  0x8000000000008003n,
  0x8000000000008002n,
  0x8000000000000080n,
  0x000000000000800an,
  0x800000008000000an,
  0x8000000080008081n,
  0x8000000000008080n,
  0x0000000080000001n,
  0x8000000080008008n,
];

/** Rotation offsets, indexed x + 5*y. */
const ROT: readonly bigint[] = [
  0n,
  1n,
  62n,
  28n,
  27n,
  36n,
  44n,
  6n,
  55n,
  20n,
  3n,
  10n,
  43n,
  25n,
  39n,
  41n,
  45n,
  15n,
  21n,
  8n,
  18n,
  2n,
  61n,
  56n,
  14n,
];

const rotl = (v: bigint, n: bigint): bigint =>
  n === 0n ? v : ((v << n) | (v >> (64n - n))) & MASK;

function keccakF(a: bigint[]): void {
  const c: bigint[] = new Array<bigint>(5).fill(0n);
  const b: bigint[] = new Array<bigint>(25).fill(0n);
  for (const rc of RC) {
    for (let x = 0; x < 5; x++) c[x] = a[x]! ^ a[x + 5]! ^ a[x + 10]! ^ a[x + 15]! ^ a[x + 20]!;
    for (let x = 0; x < 5; x++) {
      const d = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1n);
      for (let y = 0; y < 25; y += 5) a[x + y] = a[x + y]! ^ d;
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(a[x + 5 * y]!, ROT[x + 5 * y]!);
      }
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) {
        a[x + y] = b[x + y]! ^ (~b[((x + 1) % 5) + y]! & MASK & b[((x + 2) % 5) + y]!);
      }
    }
    a[0] = a[0]! ^ rc;
  }
}

const RATE = 136;

/** Keccak-256 of the bytes, as 32 bytes. */
export function keccak256Bytes(input: Uint8Array): Uint8Array {
  const state: bigint[] = new Array<bigint>(25).fill(0n);
  const padded = new Uint8Array(Math.ceil((input.length + 1) / RATE) * RATE);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] = padded[padded.length - 1]! | 0x80;
  for (let off = 0; off < padded.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + j]!);
      state[i] = state[i]! ^ lane;
    }
    keccakF(state);
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 4; i++) {
    let lane = state[i]!;
    for (let j = 0; j < 8; j++) {
      out[i * 8 + j] = Number(lane & 0xffn);
      lane >>= 8n;
    }
  }
  return out;
}

export const toHex = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;

export function fromHex(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error(`not hex: ${hex}`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Keccak-256 of a UTF-8 string or of bytes, as a 0x hex string. */
export function keccak256(input: string | Uint8Array): string {
  return toHex(keccak256Bytes(typeof input === 'string' ? new TextEncoder().encode(input) : input));
}

/* ---------------------------------------------------------------------------
   ABI encoding of static types, the only kind the channel structs use.
--------------------------------------------------------------------------- */

const word = (v: bigint): Uint8Array => {
  if (v < 0n || v >= 1n << 256n) throw new Error('value does not fit in 256 bits');
  return fromHex(v.toString(16).padStart(64, '0'));
};

/** One 32-byte word per value. Values are checked, never truncated. */
export const abi = {
  /** `address`: must be 20 bytes of hex. Case is not significant. */
  address(a: string): Uint8Array {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`not an address: ${a}`);
    return word(BigInt(a));
  },
  /** `uintN`: a non-negative integer that fits in `bits`. */
  uint(v: bigint | number | string, bits = 256): Uint8Array {
    const n = BigInt(v);
    if (n < 0n || n >= 1n << BigInt(bits))
      throw new Error(`uint${String(bits)} out of range: ${String(v)}`);
    return word(n);
  },
  /** `bytes32`: exactly 32 bytes of hex. */
  bytes32(h: string): Uint8Array {
    if (!/^0x[0-9a-fA-F]{64}$/.test(h)) throw new Error(`not bytes32: ${h}`);
    return fromHex(h);
  },
};

export function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** `keccak256(abi.encode(...words))` for words already encoded. */
export const hashWords = (...words: Uint8Array[]): string => keccak256(concat(words));

/** The 4-byte function selector for a signature such as `channels(bytes32)`. */
export const selector = (signature: string): string => keccak256(signature).slice(0, 10);

/* ---------------------------------------------------------------------------
   EIP-712
--------------------------------------------------------------------------- */

const DOMAIN_TYPEHASH = keccak256(
  'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)',
);

export function eip712DomainSeparator(d: {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}): string {
  return hashWords(
    abi.bytes32(DOMAIN_TYPEHASH),
    abi.bytes32(keccak256(d.name)),
    abi.bytes32(keccak256(d.version)),
    abi.uint(d.chainId),
    abi.address(d.verifyingContract),
  );
}

/** `keccak256("\x19\x01" ‖ domainSeparator ‖ structHash)`, the digest a wallet signs. */
export function eip712Digest(domainSeparator: string, structHash: string): string {
  return keccak256(
    concat([Uint8Array.of(0x19, 0x01), fromHex(domainSeparator), fromHex(structHash)]),
  );
}
