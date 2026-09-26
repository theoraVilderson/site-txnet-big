import { Injectable, Logger } from '@nestjs/common';
import { ActorType, ConfigProtocol, ConfigStatus, DriftState, DriverType, EnforcementState } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import { PrismaService } from '../prisma/prisma.service';
import { ConfigActionRefused, ConfigActionsService, type ConfigActionRejection } from './config-actions';
import { nameGrantLines } from './line-names';

/** What a user may do to their own config from the panel (user, 2026-09-23). Enable/disable is an operator's switch; a move needs a panel list users do not have. */
export const USER_CONFIG_ACTIONS = ['regenerate', 'retire'] as const;
export type UserConfigAction = (typeof USER_CONFIG_ACTIONS)[number];

/** How many configs one bulk request may name. */
export const MAX_BULK_CONFIGS = 50;

/** A config whose action threw something other than a refusal. Its neighbours still ran. */
export const CONFIG_ACTION_FAILED = 'failed';

/**
 * One config of a Grant, as its own user reads it (F-027-ac). Never its bare
 * `uuid`; its captured link lines are the owner's (F-307-a), the same lines
 * `/sub` hands out (F-113). The one exception is a User Manager login
 * (F-307-d): there the uuid *is* the password and there are no lines to carry
 * it, so the owner is answered it as `login`.
 */
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
  /** The buyer's own name for it (F-307-g); `null` is the default name. */
  label: string | null;
  /** The panel's link lines for the client this config is now, in the panel's order, named as `/sub` names them (ADR-0089). Empty until captured, or while a regenerate waits for the next capture. */
  lines: string[];
  /** When `lines` were captured; `null` when they are not this client's. Set with `lines` empty is a panel that gives none. */
  linksCapturedAt: string | null;
  /** A User Manager (PPPoE, OpenVPN) login, once the router confirmed this one; `null` for every other family, and while a regenerate waits. */
  login: { username: string; password: string } | null;
  /** The router's shared `.ovpn`, for an OpenVPN config with a `login`; `null` when its admin uploaded none. */
  ovpnProfile: string | null;
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
  // Read to judge whether the lines are this client's; answered only as a User Manager `login` (F-307-d).
  uuid: true,
  linksUuid: true,
  linkLines: true,
  linksCapturedAt: true,
  linksRemoteId: true,
  userLabel: true,
  panel: { select: { region: true, driverType: true, ovpnProfile: true } },
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
      const grant = await tx.grant.findFirst({ where: { id: grantId, userId }, select: { id: true, tenantId: true } });
      if (!grant) throw new ConfigActionRefused('grant_not_found', grantId);
      const rows = await tx.config.findMany({
        where: { grantId, userId, status: { not: ConfigStatus.retired } },
        select: CONFIG_VIEW_COLUMNS,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      // The reseller's line-name template (F-307-j); no row is the platform's.
      const branding = await tx.tenantBranding.findUnique({
        where: { tenantId: grant.tenantId },
        select: { brandName: true, lineNameTemplate: true },
      });
      // `/sub`'s rule (network contract.links.md): lines read from another
      // client are dead links, so they wait for the next capture.
      const isCurrent = (r: (typeof rows)[number]) => r.linksUuid !== null && r.linksUuid === r.uuid;
      // Named over this whole list, as `/sub` names it (ADR-0089 rule 3).
      const named = nameGrantLines(
        rows.map((r) => ({ label: r.userLabel, region: r.panel.region, lines: isCurrent(r) ? r.linkLines : [] })),
        { template: branding?.lineNameTemplate ?? null, brand: branding?.brandName ?? '' },
      );
      return rows.map((r, i) => {
        const current = isCurrent(r);
        // A User Manager user is named after its uuid and logs in with it
        // (network contract.drivers.md): the key the capture confirmed is
        // exactly the login the router holds now (F-307-d, user 2026-09-26).
        const login =
          current && r.linksRemoteId !== null && r.panel.driverType === DriverType.mikrotik_user_manager
            ? { username: r.linksRemoteId, password: r.uuid }
            : null;
        return {
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
          label: r.userLabel,
          lines: named[i],
          linksCapturedAt: current ? (r.linksCapturedAt?.toISOString() ?? null) : null,
          login,
          ovpnProfile: login && r.protocol === ConfigProtocol.openvpn ? r.panel.ovpnProfile : null,
        };
      });
    });
  }

  /**
   * Sets or clears the buyer's name for one of their configs (F-307-g,
   * ADR-0089). Display only: nothing is queued for its panel. A config of
   * another user, or retired, is `config_not_found`, as for an action.
   */
  setLabel(userId: string, configId: string, label: string | null): Promise<void> {
    return tenantTransaction(this.prisma, async (tx) => {
      const { count } = await tx.config.updateMany({
        where: { id: configId, userId, status: { not: ConfigStatus.retired } },
        data: { userLabel: label },
      });
      if (count === 0) throw new ConfigActionRefused('config_not_found', configId);
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
