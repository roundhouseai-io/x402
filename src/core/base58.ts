/** Base58 (the Bitcoin alphabet), which is how Solana writes keys and addresses. */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)] as const));

export function decodeBase58(text: string): Uint8Array {
  let value = 0n;
  for (const char of text) {
    const digit = INDEX.get(char);
    if (digit === undefined) throw new Error(`not base58: unexpected character "${char}"`);
    value = value * 58n + digit;
  }
  const bytes: number[] = [];
  while (value > 0n) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  // Each leading "1" is one leading zero byte.
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros += 1;
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...bytes]);
}

export function encodeBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let out = '';
  while (value > 0n) {
    out = ALPHABET[Number(value % 58n)]! + out;
    value /= 58n;
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  return '1'.repeat(zeros) + out;
}

/** A Solana address: base58 of exactly 32 bytes. */
export function isSolanaAddress(text: string): boolean {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text)) return false;
  try {
    return decodeBase58(text).length === 32;
  } catch {
    return false;
  }
}
