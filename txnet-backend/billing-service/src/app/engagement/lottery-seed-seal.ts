import { hkdfSync } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { KekService, open, seal, type SealedValue } from '@txnet-backend/shared-core';

/**
 * A lottery's seed, sealed into its draw row at the freeze (F-707-k,
 * ADR-0111 point 5, ADR-0022).
 *
 * The key is derived from the vault KEK, as `GrantTokenSeal`'s is, under its
 * own `info`: it never unwraps a tenant's DEK nor opens a subscription token,
 * and they never open a seed. `kekId` records which KEK sealed it, so a KEK
 * rotation can re-seal.
 */

/** HKDF's `info`: what the derived key is for. A new purpose gets a new string. */
const SEED_KEY_INFO = 'txnet:lottery-seed:v1';

/** What `lottery_draw.seedSealed` holds. */
export type SealedSeed = SealedValue & { kekId: string };

export function lotterySeedKey(kek: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', kek, Buffer.alloc(0), SEED_KEY_INFO, 32));
}

@Injectable()
export class LotterySeedSeal {
  private readonly keys = new Map<string, Buffer>();

  constructor(private readonly kek: KekService) {}

  /** The seed sealed under the active KEK, or `null` when none is loaded: then no lottery is frozen. */
  seal(seed: string): SealedSeed | null {
    if (!this.kek.available) return null;
    const kekId = this.kek.activeKekId;
    return { kekId, ...seal(seed, this.keyFor(kekId)) };
  }

  /** The seed, for the draw (F-707-l). Throws when the KEK named is not held, or the row was edited (GCM). */
  open(sealed: SealedSeed): string {
    return open(sealed, this.keyFor(sealed.kekId), 'a lottery seed');
  }

  private keyFor(kekId: string): Buffer {
    let key = this.keys.get(kekId);
    if (!key) {
      key = lotterySeedKey(this.kek.keyFor(kekId));
      this.keys.set(kekId, key);
    }
    return key;
  }
}
