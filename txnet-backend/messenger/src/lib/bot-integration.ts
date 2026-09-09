import { BotPlatform } from './bot-platform';

/**
 * One tenant's bot on one platform, as this unit needs to see it (F-320).
 *
 * A projection of `automation.BotIntegration`, not the row: it carries no
 * token and no secret, only the addressing a driver needs. The two credentials
 * live in the tenant Credential Vault under `credentialRef`, and the only way
 * to either of them is {@link BotIntegrationDirectory}, which audits the read
 * (ADR-0026, F-1215).
 *
 * `messenger` is a library shared by two deployables, one of which has no
 * database, so the enums below are string unions rather than the Prisma types
 * — the same values, owned here, mapped once by whoever reads the row.
 */
export interface BotIntegration {
  id: string;
  tenantId: string;
  platform: BotPlatform;
  /** The @handle, without the leading `@`. */
  botUsername: string;
  /** Unguessable, unique, and the whole inbound address (ADR-0009). */
  webhookPath: string;
  /**
   * The vault *label* both this bot's credentials are filed under — the token
   * and the webhook secret. A name, never a value: it is safe to carry and
   * useless without the tenant's DEK (ADR-0026).
   */
  credentialRef: string;
  role: BotIntegrationRole;
  status: BotIntegrationState;
}

export type BotIntegrationRole = 'primary' | 'sales' | 'support' | 'secondary';

export type BotIntegrationState = 'pending' | 'active' | 'disabled' | 'error';

/**
 * Where this unit gets integrations and their credentials.
 *
 * A port rather than a service, because the two apps that consume `messenger`
 * are not equal: `auth-service` holds the schema and the vault and answers
 * these questions directly, while `bot-service` has neither and asks
 * `auth-service` over the `X-Service-Token` seam (ADR-0011). Both bind the same
 * interface, so `BotClientRegistry` is written once and neither app's shape
 * leaks into it.
 *
 * Nothing here returns a token to a caller that did not name the exact
 * integration it is about to send as (F-323).
 */
export interface BotIntegrationDirectory {
  /**
   * The integration an inbound update belongs to, or `null`.
   *
   * The path **is** the lookup: resolving it yields the tenant and the
   * platform, and nothing about the sender is trusted before that. An unknown
   * path must be indistinguishable from a route that does not exist, which is
   * why this answers `null` rather than raising something a caller could
   * render differently.
   */
  byWebhookPath(
    platform: BotPlatform,
    webhookPath: string,
  ): Promise<BotIntegration | null>;

  /**
   * The bot a tenant sends transactional traffic as — an OTP, an alert (C-05).
   *
   * Exactly one row per `(tenantId, platform)` may hold `role: primary`, so
   * this is a lookup and not a choice.
   */
  primaryFor(
    tenantId: string,
    platform: BotPlatform,
  ): Promise<BotIntegration | null>;

  /**
   * This integration's bot token, for the code that is about to use it.
   *
   * Every call is an audited vault decryption. `null` means the tenant has no
   * usable token — not configured, revoked or expired — which is a channel
   * that is off, never an error to show a chat.
   */
  token(integration: BotIntegration, caller: string): Promise<string | null>;

  /**
   * Is there a usable token, without decrypting one?
   *
   * The question "can this channel send?" is asked far more often than it is
   * acted on — every render of the OTP channel list asks it — and answering it
   * with a decryption would both cost a round trip per channel and fill the
   * audit trail with *someone asked* instead of *someone held the value*,
   * which is the distinction that trail exists to record (ADR-0026 decision 5).
   */
  hasToken(integration: BotIntegration): Promise<boolean>;

  /**
   * Whether a candidate is this integration's webhook secret token.
   *
   * A fingerprint comparison, never a decryption: the value is not needed, only
   * the answer. A version inside its rotation grace window still verifies, so
   * an update signed seconds before a rotation is not dropped (ADR-0026
   * decision 4).
   */
  verifyWebhookSecret(
    integration: BotIntegration,
    candidate: string,
  ): Promise<boolean>;
}

/** Nest injection token for {@link BotIntegrationDirectory}. */
export const BOT_INTEGRATION_DIRECTORY = Symbol('BOT_INTEGRATION_DIRECTORY');
