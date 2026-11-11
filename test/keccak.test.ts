import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { abi, concat, fromHex, hashWords, keccak256, selector, toHex } from '../src/core/keccak.js';

// Hashes taken from viem's keccak256 in @x402/evm 2.30.0, the reference the
// channel and hold schemes are checked against.
const vectors = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'channel-vectors.json'), 'utf8'),
) as {
  keccak: Record<string, string>;
};

describe('keccak256', () => {
  it('hashes the empty input', () => {
    expect(keccak256(new Uint8Array())).toBe(vectors.keccak.empty);
    expect(vectors.keccak.empty).toBe(
      '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    );
  });

  it('hashes a short string', () => {
    expect(keccak256('abc')).toBe(vectors.keccak.abc);
  });

  it('hashes across one block boundary (200 bytes, 136-byte rate)', () => {
    expect(keccak256(new Uint8Array(200).fill(0x61))).toBe(vectors.keccak.long200);
  });

  it('hashes an input that is exactly one block', () => {
    expect(keccak256(new Uint8Array(136).fill(0x62))).toBe(vectors.keccak.exactly136);
  });

  it('is Keccak, not NIST SHA3: the empty input does not give the SHA3-256 value', () => {
    expect(keccak256('')).not.toBe(
      '0xa7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a',
    );
  });

  it('matches the reference for the strings the schemes hash', () => {
    expect(
      keccak256(
        'ChannelConfig(address payer,address payerAuthorizer,address receiver,address receiverAuthorizer,address token,uint40 withdrawDelay,bytes32 salt)',
      ),
    ).toBe(vectors.keccak.channelConfigTypehash);
    expect(selector('channels(bytes32)')).toBe(vectors.keccak.channelsSelector);
  });
});

describe('abi words', () => {
  it('pads an address to 32 bytes, left, whatever its case', () => {
    const lower = abi.address('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');
    const mixed = abi.address('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(lower).toEqual(mixed);
    expect(toHex(lower)).toBe('0x000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913');
  });

  it('refuses what is not an address', () => {
    expect(() => abi.address('0x1234')).toThrow(/not an address/);
    expect(() => abi.address('833589fcd6edb6e08f4c7c32d4f71b54bda02913')).toThrow(/not an address/);
  });

  it('encodes a uint and refuses one that does not fit, rather than truncating', () => {
    expect(toHex(abi.uint(900n, 40))).toBe(`0x${'00'.repeat(30)}0384`);
    expect(() => abi.uint(1n << 40n, 40)).toThrow(/out of range/);
    expect(() => abi.uint(-1n)).toThrow(/out of range/);
  });

  it('takes bytes32 only at exactly 32 bytes', () => {
    expect(() => abi.bytes32(`0x${'ab'.repeat(31)}`)).toThrow(/not bytes32/);
    expect(abi.bytes32(`0x${'ab'.repeat(32)}`)).toHaveLength(32);
  });

  it('hashWords is keccak of the concatenation', () => {
    const a = abi.uint(1n);
    const b = abi.uint(2n);
    expect(hashWords(a, b)).toBe(keccak256(concat([a, b])));
  });

  it('round-trips hex', () => {
    expect(toHex(fromHex('0x00ff10'))).toBe('0x00ff10');
    expect(() => fromHex('0xabc')).toThrow(/not hex/);
  });
});
