import { describe, expect, it } from 'vitest';
import { EVM_BATCH_NETWORK, registerEvmBatchScheme } from '../src/core/batchclient.js';

describe('batch-settlement client registration', () => {
  it('registers BatchSettlementEvmScheme for eip155:*', async () => {
    const mod = await import('@x402/evm/batch-settlement/client');
    const seen: string[] = [];
    registerEvmBatchScheme(
      {
        register: (network, scheme) => {
          seen.push(`${network}:${scheme.scheme}`);
        },
      },
      new mod.BatchSettlementEvmScheme({
        address: '0x1111111111111111111111111111111111111111',
        signTypedData: async () => `0x${'ab'.repeat(65)}`,
      }),
    );
    expect(EVM_BATCH_NETWORK).toBe('eip155:*');
    expect(seen).toEqual(['eip155:*:batch-settlement']);
  });
});
