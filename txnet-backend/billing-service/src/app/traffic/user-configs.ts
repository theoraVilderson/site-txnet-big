import { Injectable, Logger } from '@nestjs/common';
import { ActorType, ConfigProtocol, ConfigStatus, DriftState, EnforcementState } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { ConfigActionRefused, ConfigActionsService, type ConfigActionRejection } from './config-actions';

/** What a user may do to their own config from the panel (user, 2026-09-23). Enable/disable is an operator's switch; a move needs a panel list users do not have. */
export const USER_CONFIG_ACTIONS = ['regenerate', 'retire'] as const;
export type UserConfigAction = (typeof USER_CONFIG_ACTIONS)[number];

/** How many configs one bulk request may name. */
export const MAX_BULK_CONFIGS = 50;

/** A config whose action threw something other than a refusal. Its neighbours still ran. */
export const CONFIG_ACTION_FAILED = 'failed';

/** One config of a Grant, as its own user reads it (F-027-ac). Never its `uuid`: that is the credential, and `/sub` hands it out (F-113). */
export type UserConfigView = {
  id: string;
  protocol: ConfigProtocol;
  status: ConfigStatus;
  /** Where it is served from — the panel's region, never its name or address. */
  region: string;
  /** Bytes as decimal strings; `null` until the allocator has given it a share. */
  allocatedCeilingBytes: string | null;
  /** What the panel confirmed. A gap to `allocated` is work still queued. */
  appliedCeilingBytes: string | null;
  driftState: DriftState;
  enforcementState: EnforcementState;
  regenerateUsedCount: number;
  maxRegenerateCount: number;
  lastReconciledAt: string | null;
};

export type UserConfigOutcome =
  | { configId: string; ok: true }
  | { configId: string; ok: false; reason: ConfigActionRejection | typeof CONFIG_ACTION_FAILED };

const CONFIG_VIEW_COLUMNS = {
  id: true,
  protocol: true,
  status: true,
  allocatedCeilingBytes: true,
  appliedCeilingBytes: true,
  driftState: true,
  enforcementState: true,
  regenerateUsedCount: true,
  maxRegenerateCount: true,
  lastReconciledAt: true,
  panel: { select: { region: true } },
} as const;

/**
 * The user's service page's two needs (F-027-ac): a Grant's configs with their
 * ceiling and drift verdict, and the actions a user may take on them — one
 * config or many.
 *
 * **A bulk action is one transaction per config** (user, 2026-09-23). A config
 * that is refused — at its regenerate limit, retired meanwhile — does not
 * stop the others, and the answer names every config's outcome, so the page
 * never has to guess which one it was. Each action is still `ConfigActionsService`'s
 * desired-state write; nothing here calls a panel.
 *
 * **Ownership is the actor**, `{ user, userId }`: `ConfigActionsService` reads
 * another user's config as absent, so a foreign id is `config_not_found`
 * exactly like one that does not exist.
 */
@Injectable()
export class UserConfigsService {
  private readonly logger = new Logger(UserConfigsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly actions: ConfigActionsService,
  ) {}

  /** A Grant's live configs, oldest first. Retired ones are gone from the user's view: they deleted them. */
  listForGrant(userId: string, grantId: string): Promise<UserConfigView[]> {
    return tenantTransaction(this.prisma, async (tx) => {
      const grant = await tx.grant.findFirst({ where: { id: grantId, userId }, select: { id: true } });
      if (!grant) throw new ConfigActionRefused('grant_not_found', grantId);
      const rows = await tx.config.findMany({
        where: { grantId, userId, status: { not: ConfigStatus.retired } },
        select: CONFIG_VIEW_COLUMNS,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return rows.map((r) => ({
        id: r.id,
        protocol: r.protocol,
        status: r.status,
        region: r.panel.region,
        allocatedCeilingBytes: r.allocatedCeilingBytes?.toString() ?? null,
        appliedCeilingBytes: r.appliedCeilingBytes?.toString() ?? null,
        driftState: r.driftState,
        enforcementState: r.enforcementState,
        regenerateUsedCount: r.regenerateUsedCount,
        maxRegenerateCount: r.maxRegenerateCount,
        lastReconciledAt: r.lastReconciledAt?.toISOString() ?? null,
      }));
    });
  }

  /** Runs `action` on each config in its own transaction, in the order named, and answers every outcome. */
  async act(userId: string, action: UserConfigAction, configIds: readonly string[]): Promise<UserConfigOutcome[]> {
    const actor = { actorType: ActorType.user, actorId: userId };
    const outcomes: UserConfigOutcome[] = [];
    for (const configId of new Set(configIds)) {
      try {
        await tenantTransaction(this.prisma, async (tx) => {
          if (action === 'regenerate') await this.actions.regenerate(tx, { configId, actor });
          else await this.actions.retire(tx, { configId, actor });
        });
        outcomes.push({ configId, ok: true });
      } catch (e) {
        if (e instanceof ConfigActionRefused) {
          outcomes.push({ configId, ok: false, reason: e.reason });
        } else {
          // Its transaction rolled back; the ones before it are committed and
          // must still be reported, so this is an outcome rather than a throw.
          this.logger.error(`config ${action} failed for ${configId}`, e instanceof Error ? e.stack : String(e));
          outcomes.push({ configId, ok: false, reason: CONFIG_ACTION_FAILED });
        }
      }
    }
    return outcomes;
  }
}
