import { Injectable } from '@nestjs/common';
import { USAGE_DELTA_MESSAGE_VERSION, WalletVersionConflict, runWithTenant, type UsageDeltaMessage } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { HotLoopService } from './horizon';

/** What one pass came to. `raced` is a Grant another pass bought for first: routine, not a failure. */
export type HotLoopPass = { grants: number; failed: number; raced: number };

/** A pass written against a wire this consumer does not read. Redelivery cannot fix it: it dead-letters. */
export class UnsupportedHotLoopDeltaVersion extends Error {
  constructor(readonly version: number) {
    super(`usage delta message version ${version} — the hot loop reads ${USAGE_DELTA_MESSAGE_VERSION}`);
    this.name = 'UnsupportedHotLoopDeltaVersion';
  }
}

/**
 * The hot loop's caller (F-027-cl, ADR-0092): every collection pass
 * `network-service` publishes is a reason to look at the Grants it touched.
 *
 * The delta stream is the channel between the two halves of the hot loop
 * (`contract.hot-loop.md`). The collector already reads a config near its
 * ceiling sooner, so the passes arrive at the rate the hot few need; this
 * turns each into one `topUp` per **Grant** — never per delta, or two configs
 * of one Grant would buy two blocks for one horizon.
 *
 * It reads nothing off the message but which configs moved. The figures a
 * top-up is sized from are the Grant's and the configs' own rows, read inside
 * its transaction: the bytes in this message are `metering-service`'s to bill,
 * on its own queue, and may not have been applied yet (ADR-0092 says what that
 * lag costs).
 *
 * **One Grant failing does not stop the rest**, and a lost purchase race is not
 * a failure at all: `WalletVersionConflict` means another pass bought first,
 * and the next pass re-sizes from what it left. Anything else fails the pass
 * after the other Grants are done, so it dead-letters as evidence — nothing is
 * owed by it, because the next pass re-reads the same state.
 */
@Injectable()
export class HotLoopConsumer {
  constructor(
    /**
     * Cross-tenant because the read **produces** the tenant: a pass over a
     * platform-owned panel carries none, and one panel serves many tenants'
     * configs. It selects three columns of `config` and no usage — the same
     * read `metering-service` makes for the same message.
     */
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly hot: HotLoopService,
  ) {}

  async handle(message: UsageDeltaMessage): Promise<HotLoopPass> {
    if (message.version !== USAGE_DELTA_MESSAGE_VERSION) throw new UnsupportedHotLoopDeltaVersion(message.version);

    const pass: HotLoopPass = { grants: 0, failed: 0, raced: 0 };
    const grants = await this.grantsOf(message);
    const failures: string[] = [];

    for (const [grantId, tenantId] of grants) {
      pass.grants += 1;
      try {
        await runWithTenant({ id: tenantId }, () => this.hot.topUp({ grantId }));
      } catch (error) {
        if (error instanceof WalletVersionConflict) {
          pass.raced += 1;
          continue;
        }
        pass.failed += 1;
        failures.push(`${grantId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (failures.length > 0) {
      throw new Error(`hot loop over panel ${message.panelId}: ${failures.length} of ${pass.grants} Grants failed — ${failures.join('; ')}`);
    }
    return pass;
  }

  /** Grant id -> its tenant, once each, for the configs this pass carried a delta for. */
  private async grantsOf(message: UsageDeltaMessage): Promise<Map<string, string>> {
    const ids = [...new Set(message.deltas.map((delta) => delta.configId))];
    if (ids.length === 0) return new Map();
    const rows = await this.crossTenant.config.findMany({
      where: { id: { in: ids } },
      select: { id: true, grantId: true, tenantId: true },
    });
    return new Map(rows.map((row) => [row.grantId, row.tenantId]));
  }
}
