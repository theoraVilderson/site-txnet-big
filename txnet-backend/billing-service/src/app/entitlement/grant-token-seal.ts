import { hkdfSync } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { KekService, open, seal, type SealedValue } from '@txnet-backend/shared-core';

/**
 * The subscription token, kept sealed beside its hash (F-114-e-a, D-43, ADR-0085).
 *
 * The hash is what `/sub` looks a Grant up by, and it cannot give the link back.
 * This sealed copy is what lets My services show the same link as often as it
 * is asked for, instead of once.
 *
 * The key is derived from the vault KEK rather than being the KEK itself. That
 * keeps two jobs apart: this key never unwraps a tenant's DEK, and the KEK never
 * opens a token. `kekId` records which KEK sealed a row, as `tenant_dek` does, so
 * rotating the KEK can re-seal the tokens.
 */

/** HKDF's `info`: what the derived key is for. A new purpose gets a new string. */
const TOKEN_KEY_INFO = 'txnet:grant-token:v1';

/** What `grant.subscriptionTokenSealed` holds. */
export type SealedToken = SealedValue & { kekId: string };

/** The token key for one KEK. */
export function grantTokenKey(kek: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', kek, Buffer.alloc(0), TOKEN_KEY_INFO, 32));
}

@Injectable()
export class GrantTokenSeal {
  /** Derived once per KEK: `hkdfSync` is cheap, but a list of Grants would repeat it for every row. */
  private readonly keys = new Map<string, Buffer>();

  constructor(private readonly kek: KekService) {}

  /**
   * The token sealed under the active KEK, or `null` when no KEK is loaded.
   * A missing key must not refuse a sale: the Grant is issued, and it holds no
   * link until one is reset under a KEK (ADR-0085 (4)).
   */
  seal(token: string): SealedToken | null {
    if (!this.kek.available) return null;
    const kekId = this.kek.activeKekId;
    return { kekId, ...seal(token, this.keyFor(kekId)) };
  }

  /** The token. Throws when the KEK named is not held, or the row was edited (GCM). */
  open(sealed: SealedToken): string {
    return open(sealed, this.keyFor(sealed.kekId), 'a subscription token');
  }

  private keyFor(kekId: string): Buffer {
    let key = this.keys.get(kekId);
    if (!key) {
      key = grantTokenKey(this.kek.keyFor(kekId));
      this.keys.set(kekId, key);
    }
    return key;
  }
}

/** For a caller built without the module (specs, scripts): no KEK, so nothing is sealed. */
export const NO_TOKEN_SEAL = new GrantTokenSeal({ available: false } as KekService);
