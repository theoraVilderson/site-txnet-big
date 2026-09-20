import { Injectable } from '@nestjs/common';
import {
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  ResellerActor,
  TenantCapabilityName,
} from '@txnet-backend/shared-core';

export type TenantAccessActor = ResellerActor;
export type TenantAccessRejection = ResellerAccessRejection;

/**
 * What a caller may do with one reseller, as two booleans.
 *
 * `reason` is why **nothing** is allowed, and is `null` the moment `canRead` is
 * true: a surface that may open needs no sentence for the buttons it simply
 * does not offer.
 */
export type TenantAccessView = {
  tenantId: string;
  /** May open the reseller's own screens at all — `read` in the status matrix. */
  canRead: boolean;
  /** May change something there — `staffWrite`. */
  canWrite: boolean;
  reason: TenantAccessRejection | null;
};

/**
 * "May I administer this reseller?" (F-311-e) — the door answering the question
 * a surface would otherwise have to guess at.
 *
 * Every reseller-named route already runs `ResellerAccess` (tenant invariant
 * 21), so a *screen* that wants to know whether to offer itself had only two
 * options: re-derive the rule from the session, or call a data route and read
 * its refusal as a verdict. The first is a second copy of invariant 21 — and
 * an impossible one, because the owner signs in in their own platform tenant
 * (ADR-0059) and nothing in their session names the reseller they own. The
 * second reads "may I?" out of "give me", so a permission split on that data
 * route silently changes the answer.
 *
 * So the door is asked directly, and it is asked **twice, with one `now`**: the
 * status matrix answers `read` and `staffWrite` differently — a suspended
 * reseller still reads and no longer writes (`tenant/rules.md`) — and a single
 * boolean would have to lie about one of them. Two admissions cost two more
 * indexed reads than one; deciding the second from the first would mean
 * copying the matrix into this file, which is the thing invariant 21 exists to
 * prevent.
 *
 * **It reads no data of the reseller's** and opens no scope: there is nothing
 * to run inside `ResellerAccess.run`, which is why this is `admit` and not
 * `run`. The answer is about the caller, so nothing here is cached: a seat
 * revoked a second ago must not still be administering (the reasoning of
 * ADR-0033).
 */
@Injectable()
export class TenantAccessService {
  constructor(private readonly access: ResellerAccess) {}

  async verdict(actor: TenantAccessActor, tenantId: string, now = new Date()): Promise<TenantAccessView> {
    const read = await this.admits(actor, tenantId, 'read', now);
    // Refused the reading: there is no write to ask about, and the reason the
    // door gave is the whole answer — including which callers are allowed to
    // learn that this reseller exists.
    if (read !== null) return { tenantId, canRead: false, canWrite: false, reason: read };

    const write = await this.admits(actor, tenantId, 'staffWrite', now);
    return { tenantId, canRead: true, canWrite: write === null, reason: null };
  }

  /** `null` when the door admits; otherwise its reason. A refusal is an answer here, never an error. */
  private async admits(
    actor: TenantAccessActor,
    tenantId: string,
    capability: TenantCapabilityName,
    now: Date,
  ): Promise<TenantAccessRejection | null> {
    try {
      await this.access.admit(actor, tenantId, capability, now);
      return null;
    } catch (e) {
      // Only the door's own refusal is a verdict. A reader that threw is a
      // failure, and turning it into `canRead: false` would read as "you may
      // not" to every surface that asks.
      if (!(e instanceof ResellerAccessRefused)) throw e;
      return e.reason;
    }
  }
}
