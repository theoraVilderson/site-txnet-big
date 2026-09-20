import { Injectable, Logger } from '@nestjs/common';
import { TenantCredentialKind } from '@prisma/client';
import {
  BotIntegration,
  BotIntegrationDirectory,
  BotPlatform,
  newWebhookPath,
} from '@txnet-backend/messenger';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import {
  CredentialRef,
  CredentialUnavailable,
  CredentialVaultService,
} from '@txnet-backend/shared-core';

/**
 * Which vault kind holds a platform's bot token.
 *
 * A record rather than a string built from the platform name, so adding a
 * platform is a type error here instead of a `CredentialUnavailable` at
 * runtime.
 */
export const BOT_TOKEN_KIND: Record<BotPlatform, TenantCredentialKind> = {
  telegram: TenantCredentialKind.telegram_bot_token,
  bale: TenantCredentialKind.bale_bot_token,
};

/**
 * `messenger`'s directory, answered from the schema and the vault (F-320).
 *
 * This is the first code to implement any of `automation`, and it implements
 * exactly one table: `BotIntegration` (F-315, F-316). It is hosted in
 * `auth-service` for the same reason `tenant`'s resolver is — the only callers
 * so far are this process's own edge and `bot-service` over the
 * `X-Service-Token` seam (ADR-0011).
 *
 * **Why the reads are cross-tenant.** An inbound update is addressed by its
 * webhook path *in order to discover which tenant it belongs to*, so there is
 * no scope to read it under: the lookup is what opens one. That is why
 * `bot_integration` and the two vault tables are deliberately outside
 * `TENANT_SCOPED_MODELS` (ADR-0024, `tenant/contract.vault.md`), and why the
 * escape is named here rather than hidden. What confines the answer is the
 * path itself — unguessable, unique, and never trusted before it resolves.
 *
 * Since F-066-m-b the escape is `CrossTenantPrismaService` rather than
 * `runAcrossTenants`, because `bot_integration` now carries an RLS policy and
 * the callback never made the application's own pool able to read past one. The
 * two writes below (`recordRegistration`, `rotateWebhookPath`) go through it as
 * well, and that is a widening of catalog 20.2 layer 1, which names cross-tenant
 * *reads*: both address a row by its primary key, both are the platform
 * recording what it just did to an integration it reached by path, and neither
 * has a tenant in scope to be checked against for the same reason the reads do
 * not. The alternative — resolving the tenant first, purely to write a row the
 * lookup already found — would add a query that could only ever agree.
 */
/** The columns {@link PrismaBotIntegrationDirectory.project} reads. */
type PrismaBotIntegrationRow = Omit<BotIntegration, 'platform'> & {
  platform: string;
};

@Injectable()
export class PrismaBotIntegrationDirectory implements BotIntegrationDirectory {
  private readonly logger = new Logger(PrismaBotIntegrationDirectory.name);

  constructor(
    private readonly prisma: CrossTenantPrismaService,
    private readonly vault: CredentialVaultService,
  ) {}

  async byWebhookPath(
    platform: BotPlatform,
    webhookPath: string,
  ): Promise<BotIntegration | null> {
    if (!webhookPath) return null;
    const row = await this.prisma.botIntegration.findUnique({
      where: { webhookPath },
    });
    // The path is unique platform-wide, so a row found under the wrong
    // platform is a path being replayed against the other messenger's route.
    // It answers `null` like any unknown path: the caller renders one 404.
    if (!row || row.platform !== platform) return null;
    return this.project(row);
  }

  async primaryFor(
    tenantId: string,
    platform: BotPlatform,
  ): Promise<BotIntegration | null> {
    const row = await this.prisma.botIntegration.findFirst({
      where: { tenantId, platform, role: 'primary' },
    });
    return row ? this.project(row) : null;
  }

  /**
   * One tenant's bot, named by its `@handle` rather than by its address
   * (F-322).
   *
   * The admin rotation route needs to reach an integration *without* being
   * given the path, because the path is the credential it is about to replace
   * and a credential does not belong in a URL. `@@unique([tenantId, platform,
   * botUsername])` is what makes the handle a sufficient name, and the
   * `tenantId` in it is what stops the route from reaching another brand's bot.
   */
  async byTenantBot(
    tenantId: string,
    platform: BotPlatform,
    botUsername: string,
  ): Promise<BotIntegration | null> {
    if (!botUsername) return null;
    const row = await this.prisma.botIntegration.findUnique({
      where: {
        tenantId_platform_botUsername: { tenantId, platform, botUsername },
      },
    });
    return row ? this.project(row) : null;
  }

  /**
   * Every bot one tenant has, for that tenant's own screen (F-066-w5).
   *
   * Addressed by `tenantId` and read on the cross-tenant pool like everything
   * else here, so the filter in the `where` is the whole confinement — which is
   * safe only because the caller has already been admitted to *that* reseller
   * by `ResellerAccess` and hands the id it was admitted to, never one off the
   * request.
   */
  async listForTenant(tenantId: string): Promise<BotIntegration[]> {
    const rows = await this.prisma.botIntegration.findMany({
      where: { tenantId },
      orderBy: [{ platform: 'asc' }, { botUsername: 'asc' }],
    });
    return rows.map((row) => this.project(row));
  }

  /**
   * Add a bot a tenant has just connected (F-066-w5).
   *
   * The `webhookPath` is minted here rather than by the caller, for the reason
   * `webhook-address.ts` gives: the address is a credential and whoever builds
   * one builds all of them. A `P2002` is left to propagate — `(tenantId,
   * platform, botUsername)` is a real unique key and the caller's answer for a
   * duplicate is not this class's to choose.
   */
  async create(input: {
    tenantId: string;
    platform: BotPlatform;
    botUsername: string;
    credentialRef: string;
    role?: BotIntegration['role'];
  }): Promise<BotIntegration> {
    const row = await this.prisma.botIntegration.create({
      data: {
        tenantId: input.tenantId,
        platform: input.platform,
        botUsername: input.botUsername,
        credentialRef: input.credentialRef,
        role: input.role ?? 'primary',
        webhookPath: newWebhookPath(),
        // `pending` and not `active`: the row exists, the platform has not been
        // told yet, and claiming otherwise is the one thing `recordRegistration`
        // is there to decide.
        status: 'pending',
      },
    });
    return this.project(row);
  }

  /**
   * Retire a bot: the row goes (F-066-w5, user's call 2026-09-20).
   *
   * Deleted rather than flipped to `disabled`, because `disabled` already means
   * "a human switched it off" — a reversible pause — and a state that means both
   * cannot answer which one happened. Its credentials are revoked by the caller
   * **before** this runs, so the failure this order allows is a revoked bot
   * whose row survives: visible, harmless and re-runnable. The other order
   * would leave a live token nothing points at.
   *
   * Addressed by id, and by the `tenantId` the caller was admitted to as well:
   * the pool here can see every tenant, so the scoping has to be in the `where`
   * — a delete that matches nothing is not an error, it is a row somebody else
   * already retired.
   */
  async remove(integration: BotIntegration): Promise<void> {
    await this.prisma.botIntegration.deleteMany({
      where: { id: integration.id, tenantId: integration.tenantId },
    });
  }

  /**
   * Every integration the platform should have a live webhook for (F-321).
   *
   * `disabled` rows are excluded — a tenant that switched its bot off must not
   * have it silently re-registered on the next boot. `error` rows are
   * included: an error is the state a registration failed *into*, so leaving
   * them out would make the failure permanent.
   */
  async allRegistrable(): Promise<BotIntegration[]> {
    const rows = await this.prisma.botIntegration.findMany({
      where: { status: { not: 'disabled' } },
    });
    return rows.map((row) => this.project(row));
  }

  /**
   * Record how a registration went (F-321).
   *
   * `status` and `lastErrorAt` are the two fields a tenant can see about its
   * own bot, which is why the failure is written down rather than only logged:
   * "the bot stopped answering" has to be answerable from the panel.
   */
  async recordRegistration(
    integrationId: string,
    outcome: { ok: boolean },
  ): Promise<void> {
    await this.prisma.botIntegration.update({
      where: { id: integrationId },
      data: outcome.ok
        ? { status: 'active', lastErrorAt: null }
        : { status: 'error', lastErrorAt: new Date() },
    });
  }

  /**
   * Give this integration a new inbound address, and retire the old one
   * (F-322, catalog 10.2).
   *
   * The write *is* the retirement. `byWebhookPath` is a lookup on a unique
   * column with nothing cached in front of it, in either process, so the
   * moment this row commits the previous path resolves to `null` and answers
   * the same bare 404 a route that never existed does. That is what "the old
   * path immediately stops responding" means here: no boot, no cache expiry
   * and no upstream round trip stands between a leaked path and its death.
   *
   * The row goes back to `pending` because it is now unregistered by
   * definition — the platform is still delivering to an address this service
   * has just stopped answering, and until {@link WebhookRotationService} has
   * called `setWebhook` the honest state is "not registered yet", not "active".
   *
   * A collision on 32 random bytes is not a thing that happens, but a unique
   * violation here would surface as a 500 on a security operation, so it is
   * retried rather than reasoned about.
   */
  async rotateWebhookPath(integration: BotIntegration): Promise<BotIntegration> {
    for (let attempt = 0; ; attempt++) {
      const webhookPath = newWebhookPath();
      try {
        const row = await this.prisma.botIntegration.update({
          where: { id: integration.id },
          data: { webhookPath, status: 'pending', lastErrorAt: null },
        });
        return this.project(row);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== 'P2002' || attempt >= 2) throw err;
      }
    }
  }

  /**
   * The bot token, decrypted and audited (F-1215).
   *
   * `CredentialUnavailable` is answered with `null` rather than propagated: to
   * everything above this, a tenant whose token is missing, revoked or expired
   * is a channel that is off, and that is not a failure to show a chat. The
   * reason is logged here, which is where an operator will look for it.
   */
  async token(
    integration: BotIntegration,
    caller: string,
  ): Promise<string | null> {
    try {
      return await this.vault.use(this.tokenRef(integration), { caller });
    } catch (err) {
      if (err instanceof CredentialUnavailable) {
        this.logger.warn(
          `${integration.platform}: no usable token for integration ` +
            `${integration.id} (${err.reason})`,
        );
        return null;
      }
      throw err;
    }
  }

  /**
   * The webhook secret token, for the code that is about to *register* it.
   *
   * Distinct from {@link verifyWebhookSecret}, which only compares: registering
   * a webhook means handing the value to the platform, so this one decrypts and
   * is audited like any other use. `null` means the tenant has none, which is a
   * legal registration — the 32-byte path is the credential either way.
   */
  async webhookSecret(
    integration: BotIntegration,
    caller: string,
  ): Promise<string | null> {
    try {
      return await this.vault.use(
        {
          tenantId: integration.tenantId,
          kind: TenantCredentialKind.webhook_secret,
          label: this.label(integration),
        },
        { caller },
      );
    } catch (err) {
      if (err instanceof CredentialUnavailable) return null;
      throw err;
    }
  }

  /**
   * Is there a usable token, without decrypting one?
   *
   * `summary` reads the row and returns no plaintext, so it writes no audit
   * row — which is the point: this is asked on every channel list.
   */
  async hasToken(integration: BotIntegration): Promise<boolean> {
    const summary = await this.vault.summary(this.tokenRef(integration));
    if (!summary || !summary.configured) return false;
    if (summary.status !== 'active') return false;
    return !summary.expiresAt || summary.expiresAt.getTime() > Date.now();
  }

  /**
   * The webhook secret token, compared without being decrypted (F-321).
   *
   * The vault's `verify` accepts a superseded version still inside its
   * rotation grace window, which is what keeps an update signed seconds before
   * a rotation from being dropped (ADR-0026 decision 4).
   */
  verifyWebhookSecret(
    integration: BotIntegration,
    candidate: string,
  ): Promise<boolean> {
    if (!candidate) return Promise.resolve(false);
    return this.vault.verify(
      {
        tenantId: integration.tenantId,
        kind: TenantCredentialKind.webhook_secret,
        label: this.label(integration),
      },
      candidate,
    );
  }

  private tokenRef(integration: BotIntegration): CredentialRef {
    return {
      tenantId: integration.tenantId,
      kind: BOT_TOKEN_KIND[integration.platform],
      label: this.label(integration),
    };
  }

  /**
   * The vault label both credentials share: the row's own `credentialRef`.
   *
   * One label, two kinds — the token and the webhook secret — so a rotation of
   * either is addressed by the same name the integration already carries
   * (ADR-0026, `automation.prisma`).
   */
  private label(integration: BotIntegration): string {
    return integration.credentialRef;
  }

  /** The row, minus everything a caller has no business holding (F-323). */
  private project(row: PrismaBotIntegrationRow): BotIntegration {
    return {
      id: row.id,
      tenantId: row.tenantId,
      platform: row.platform as BotPlatform,
      botUsername: row.botUsername,
      webhookPath: row.webhookPath,
      credentialRef: row.credentialRef,
      role: row.role,
      status: row.status,
    };
  }
}
