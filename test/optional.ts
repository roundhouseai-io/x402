import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

/**
 * Whether an optional peer dependency is actually installed here.
 *
 * `ethers` and `@open-wallet-standard/core` are optional peers: absent on a
 * plain `npm ci`, present for anyone who set up signing, and present in the
 * integration job. Tests that assert what happens when one is *missing* are
 * therefore assertions about the machine, not the code — they passed in CI and
 * failed on a maintainer's laptop for a reason that had nothing to do with the
 * change under test. Gate them on this instead of on luck.
 */
export function isInstalled(spec: string): boolean {
  try {
    require_.resolve(spec);
    return true;
  } catch {
    return false;
  }
}
