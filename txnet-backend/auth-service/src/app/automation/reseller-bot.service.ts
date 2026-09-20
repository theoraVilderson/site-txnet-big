import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantCredentialKind } from '@prisma/client';
import {
  BotClientRegistry,
  BotIntegration,
  BotPlatform,
  newWebhookPath,
  redactedWebhookUrl,
  resolveWebhookBase,
  webhookUrl,
} from '@txnet-backend/messenger';
import {
  CredentialRef,
  CredentialVaultService,
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  ResellerActor,
  TenantCapabilityName,
} from '@txnet-backend/shared-core';

import {
  BOT_TOKEN_KIND,
  PrismaBotIntegrationDirectory,
} from './bot-integration.directory';

/** The caller, as `forward-auth` proved them. */
export type ResellerBotActor = ResellerActor;

/** Both doors' refusals: who may configure this reseller, and what may be done to its bots. */
export type ResellerBotRejection =
  | ResellerAccessRejection
  | 'invalid_token'
  | 'bot_already_connected'
  | 'primary_exists'
  | 'bot_not_found'
  | 'vault_unavailable';

/** A refusal, carrying the reason of whichever door closed. */
export class ResellerBotRefused extends Error {
  constructor(
    readonly reason: ResellerBotRejection,
    detail?: string,
  ) {
    super(detail ? `${reason}: ${detail}` : reason);
    this.name = 'ResellerBotRefused';
  }
}

/**
 * One connected bot, as this surface answers it.
 *
 * Three fields of the row are deliberately absent. `webhookPath` is the bot's
 * whole address and therefore a credential (ADR-0009); `credentialRef` names
 * the two vault rows; and the token was never a column to leave out. What is
 * left is what a screen renders (F-066-w6) and what a reseller can act on.
 */
export interface ResellerBotView {
  id: string;
  platform: BotPlatform;
  botUsername: string;
  role: BotIntegration['role'];
  status: BotIntegration['status'];
}

/** What a reseller pastes into the form. */
export interface ConnectBotInput {
  platform: BotPlatform;
  token: string;
}

/**
 * Connecting and retiring the bots of the reseller a route **names**
 * (F-066-w5, ADR-0064): `/api/auth/tenants/:tenantId/bots`.
 *
 * **Why this service.** ADR-0064 gives each configuring service a second route
 * set beside its ambient one, and `automation` has exactly one home: the
 * `bot_integration` table, the Credential Vault and the Bot API calls all live
 * in `auth-service` already — `WebhookRotationService` registers a webhook from
 * this process today (user's call, 2026-09-20). `bot-service` owns the *inbound*
 * door and nothing else; making it own the form would mean a new internal seam
 * carrying a plaintext token in the opposite direction, which is the one thing
 * F-323 is about.
 *
 * **The order of a connect is the feature**, and it is the same order the
 * F-069 seeder settled on: prove, store, create, register.
 *
 * 1. **Prove.** The token is checked against the messenger itself (`getMe`)
 *    before anything is written. That is also where the `@handle` comes from —
 *    asking the reseller for it would let a typo file the row under a name no
 *    deep link resolves to, and the handle is half of `(tenantId, platform,
 *    botUsername)`.
 * 2. **Store.** Both credentials go into the vault first. A row whose token is
 *    missing is the one state `BotClientRegistry` cannot recover from on its
 *    own; a vault row no integration points at is invisible and is swept by
 *    `vault_credential_retention` (F-031-c). If the row then collides, what was
 *    just written is revoked rather than left behind.
 * 3. **Register.** Last, and allowed to fail: a messenger that is down is a bot
 *    that is quiet, not a connect that did not happen. The row stays `pending`,
 *    which is registrable, so `bot-service`'s registrar picks it up on its next
 *    boot — and the caller is told `registered: false` rather than a lie.
 *
 * **A retire is that run backwards, with one thing not allowed to fail.** The
 * webhook is withdrawn, both credentials are revoked, and the row is deleted —
 * in that order, so the only state a part-way failure can leave is a bot whose
 * token is already dead. Whether the platform accepted the withdrawal is
 * reported, never waited on: `deleteWebhook` returning `false` is a messenger
 * that will keep posting to a path that no longer resolves, which is a 404 on
 * this side, while a token still working would be a real one.
 *
 * **Role.** Every bot connected here is the `primary` (C-05) — it is what
 * carries OTP and transactional alerts, and it is the step the onboarding
 * console is asking for. A second `primary` on one platform is refused rather
 * than silently demoted; `sales` / `support` / `secondary` are F-315's and have
 * no surface yet.
 *
 * **Capabilities** are the reseller's own status matrix: `read` to list, so a
 * suspended reseller still sees what it has, and `staffWrite` for both writes —
 * the pair every other reseller-named surface uses.
 */
@Injectable()
export class ResellerBotService {
  private readonly logger = new Logger(ResellerBotService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly access: ResellerAccess,
    private readonly directory: PrismaBotIntegrationDirectory,
    private readonly vault: CredentialVaultService,
    private readonly bots: BotClientRegistry,
  ) {}

  /** Every bot this reseller has. Never a credential, never an address. */
  list(actor: ResellerBotActor, tenantId: string): Promise<ResellerBotView[]> {
    return this.run(actor, tenantId, 'read', async (reseller) => {
      const integrations = await this.directory.listForTenant(reseller);
      return integrations.map((i) => this.view(i));
    });
  }

  /**
   * Connect a bot from a pasted token.
   *
   * `registered` is the honest second half of the answer: the bot exists either
   * way, and a screen that showed only success would leave a reseller waiting
   * for a bot the platform was never told about.
   */
  connect(
    actor: ResellerBotActor,
    tenantId: string,
    input: ConnectBotInput,
  ): Promise<{ bot: ResellerBotView; registered: boolean }> {
    return this.run(actor, tenantId, 'staffWrite', async (reseller) => {
      this.requireVault();

      // Prove first: nothing is written for a token the messenger refuses, so
      // a mistyped paste costs a round trip and no row.
      const me = await this.bots.clientForToken(input.platform, input.token).getMe();
      if (!me) throw new ResellerBotRefused('invalid_token', input.platform);
      const botUsername = me.username.replace(/^@/, '');

      // Both of these are races the unique index also closes — they are checked
      // here so the common case gets its own reason instead of a P2002.
      if (await this.directory.byTenantBot(reseller, input.platform, botUsername)) {
        throw new ResellerBotRefused('bot_already_connected', botUsername);
      }
      if (await this.directory.primaryFor(reseller, input.platform)) {
        throw new ResellerBotRefused('primary_exists', input.platform);
      }

      const credentialRef = `bot:${input.platform}:${botUsername}`;
      const refs = this.refs(reseller, input.platform, credentialRef);
      // The webhook secret is minted, not asked for: it is a header check the
      // platform echoes back, so nobody outside this process ever needs to
      // read it. 32 bytes of hex is what one is.
      //
      // `createdBy` is the acting user — a real uuid, unlike the F-069 seeder,
      // which no human runs and which therefore leaves the column null. A
      // credential a person pasted should say which person.
      const createdBy = actor.userId;
      await this.vault.put(refs.token, input.token, { createdBy });
      await this.vault.put(refs.secret, newWebhookPath(), { createdBy });

      let integration: BotIntegration;
      try {
        integration = await this.directory.create({
          tenantId: reseller,
          platform: input.platform,
          botUsername,
          credentialRef,
        });
      } catch (err) {
        // Whatever was just written points at nothing now. Revoking is the
        // difference between a failed connect and a live token in the vault.
        await this.revoke(refs);
        if ((err as { code?: string }).code === 'P2002') {
          throw new ResellerBotRefused('bot_already_connected', botUsername);
        }
        throw err;
      }

      const registered = await this.register(integration);
      await this.directory.recordRegistration(integration.id, { ok: registered });
      return {
        bot: this.view({ ...integration, status: registered ? 'active' : 'error' }),
        registered,
      };
    });
  }

  /**
   * Retire a bot: withdraw the webhook, revoke both credentials, delete the row.
   *
   * Named by its `@handle` and not by its id, for the reason
   * `byTenantBot` gives — and because that is what the screen shows.
   */
  retire(
    actor: ResellerBotActor,
    tenantId: string,
    platform: BotPlatform,
    botUsername: string,
  ): Promise<{ retired: true; webhookRemoved: boolean }> {
    return this.run(actor, tenantId, 'staffWrite', async (reseller) => {
      this.requireVault();

      const integration = await this.directory.byTenantBot(
        reseller,
        platform,
        botUsername.replace(/^@/, ''),
      );
      if (!integration) throw new ResellerBotRefused('bot_not_found', botUsername);

      // Best-effort and first, while the token is still usable: this is the
      // only moment the platform can be told to stop delivering.
      const client = await this.bots.client(integration, 'automation:ResellerBotService');
      const webhookRemoved = client ? await client.deleteWebhook() : false;
      if (!webhookRemoved) {
        this.logger.warn(
          `${this.name(integration)}: retired without withdrawing its webhook — ` +
            `the platform will keep posting to a path that no longer resolves`,
        );
      }

      // Not best-effort. A revoked token is what actually ends the bot, so a
      // failure here leaves the row and the whole retire is re-runnable.
      await this.revoke(this.refs(reseller, platform, integration.credentialRef));
      await this.directory.remove(integration);
      this.logger.log(`${this.name(integration)}: retired by ${actor.userId}`);
      return { retired: true as const, webhookRemoved };
    });
  }

  /**
   * Admit, then run in the reseller's scope, then translate the door's refusal.
   *
   * `ResellerAccessRefused` becomes a `ResellerBotRefused` here so the
   * controller maps one error type and a new reason on either door cannot be
   * forgotten by it.
   */
  private async run<T>(
    actor: ResellerBotActor,
    tenantId: string,
    capability: TenantCapabilityName,
    work: (resellerId: string) => Promise<T>,
    now?: Date,
  ): Promise<T> {
    try {
      return await this.access.run(
        actor,
        tenantId,
        capability,
        (reseller) => work(reseller.id),
        now,
      );
    } catch (err) {
      if (err instanceof ResellerAccessRefused) {
        throw new ResellerBotRefused(err.reason, tenantId);
      }
      throw err;
    }
  }

  /** Point the platform at this bot's door, the way every other registration does. */
  private async register(integration: BotIntegration): Promise<boolean> {
    const base = resolveWebhookBase(
      (key) => this.config.get<string>(key),
      integration.platform,
    );
    if (!base) {
      this.logger.warn(
        `${integration.platform}: no webhook base — set ` +
          `${integration.platform.toUpperCase()}_WEBHOOK_PUBLIC_BASE, ` +
          `BOT_WEBHOOK_PUBLIC_BASE or DOMAIN_NAME`,
      );
      return false;
    }
    const client = await this.bots.client(
      integration,
      'automation:ResellerBotService',
    );
    if (!client) return false;

    const secret = await this.directory.webhookSecret(
      integration,
      'automation:ResellerBotService',
    );
    // The URL carries the path, which is the credential — never logged whole.
    this.logger.log(
      `${this.name(integration)}: registering ` +
        redactedWebhookUrl(base, integration.platform),
    );
    return client.setWebhook(webhookUrl(base, integration), secret ?? undefined);
  }

  /** The two vault rows one bot has: the token, and the webhook secret beside it. */
  private refs(
    tenantId: string,
    platform: BotPlatform,
    label: string,
  ): { token: CredentialRef; secret: CredentialRef } {
    return {
      token: { tenantId, kind: BOT_TOKEN_KIND[platform], label },
      secret: { tenantId, kind: TenantCredentialKind.webhook_secret, label },
    };
  }

  private async revoke(refs: { token: CredentialRef; secret: CredentialRef }): Promise<void> {
    await this.vault.revoke(refs.token);
    await this.vault.revoke(refs.secret);
  }

  /**
   * A deployment with no KEK cannot store a token and must not pretend to.
   *
   * Checked before the messenger is called on a connect, and before anything is
   * withdrawn on a retire: a retire that could not revoke would report a bot as
   * gone while its token still worked.
   */
  private requireVault(): void {
    if (!this.vault.available) {
      throw new ResellerBotRefused('vault_unavailable');
    }
  }

  /** The row, minus its two credentials and its address (F-323, ADR-0009). */
  private view(integration: BotIntegration): ResellerBotView {
    return {
      id: integration.id,
      platform: integration.platform,
      botUsername: integration.botUsername,
      role: integration.role,
      status: integration.status,
    };
  }

  /** `telegram/@acmebot` — enough to find the row, never the path. */
  private name(integration: BotIntegration): string {
    return `${integration.platform}/@${integration.botUsername}`;
  }
}
