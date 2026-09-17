import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenantSmsMode } from '@prisma/client';
import {
  CredentialVaultService,
  SMS_TRANSPORT_FAILURE,
  SmsProviderService,
  smsLineConfigured,
  smsLineCredentials,
} from '@txnet-backend/shared-core';

import type { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';

/** What one send came to. Only `refused` is final for the row; `line_down` is the operator's problem. */
export type SmsSend =
  | { status: 'sent' }
  | { status: 'refused' | 'retry' | 'line_down'; description: string };

export interface SmsLine {
  send(to: string, text: string): Promise<SmsSend>;
}

export type SmsLineAnswer = { kind: 'ready'; line: SmsLine } | { kind: 'none' } | { kind: 'stalled' };

/** Gateway answers that mean this number, not the account, is the problem. */
const REFUSED_RECIPIENT = new Set(['InvalidReceiverNumber']);

/**
 * An SMS gateway account as a campaign line — the platform's, or a reseller's own. The text goes as stored: no
 * `vars`, so a `{{…}}` an admin typed reaches the user untouched.
 */
export function platformSmsLine(provider: Pick<SmsProviderService, 'sendSMS'>, sender: string): SmsLine {
  return {
    async send(to, text) {
      const result = await provider.sendSMS({ msg: text, to }, sender);
      if (result.ok) return { status: 'sent' };
      if (REFUSED_RECIPIENT.has(result.msg)) return { status: 'refused', description: result.msg };
      if (result.msg === SMS_TRANSPORT_FAILURE) return { status: 'retry', description: result.msg };
      // Bad credentials, no credit, a blocked sender: every next row would get the same answer.
      return { status: 'line_down', description: String(result.msg) };
    },
  };
}

/**
 * D-38 (invariant 10): a line the platform pays for and signs as the platform
 * carries only the platform owner's own campaign to the platform owner's own
 * users. The SMS line and the mail server (F-035-h) both ask this.
 */
export function platformOwnersOwn(campaignTenantId: string | null, recipientTenantId: string, ownerTenantId: string | null): boolean {
  return !!ownerTenantId && campaignTenantId === ownerTenantId && recipientTenantId === ownerTenantId;
}

/**
 * **Which SMS line a campaign row goes out on, and who pays for it** (F-035-f,
 * F-035-i-a, D-38, invariant 10) — the one place that decides.
 *
 * Two kinds of line, neither metered:
 * - **the platform's**: `SMS_API_URL` and the platform owner's `sms_api_key` /
 *   `sms_sender_line` vault values (F-018-a), the OTP sender's. It carries only
 *   the platform owner's own campaign to the platform owner's own users: a
 *   reseller's campaign would cost the platform, and a platform-wide one would
 *   show a reseller's customer the platform's number;
 * - **a reseller's own** (`tenant_sms_config` `own_credentials`, active): the
 *   same gateway with that tenant's own vault values. It carries only that
 *   tenant's campaign to that tenant's users — its number, its bill.
 *
 * Anything else is `none`, and the row fails. A platform-wide campaign has no
 * tenant and so only ever the owner's line — which refuses it. A line that is
 * configured but could not be opened is `stalled`.
 *
 * One resolver per delivery run ({@link SmsLineSource}), so the credentials are
 * read once per run rather than once per row. The metered platform line for a
 * reseller (`use_platform_sms`, `sms_sent`) is F-035-i-b and changes this
 * function, not its callers.
 */
export class SmsLineResolver {
  /**
   * @param platform the owner's line, `null` if it could not be opened.
   * @param own every reseller with its own line configured, keyed by tenant; `null` = could not be opened.
   */
  constructor(
    private readonly platform: SmsLine | null,
    private readonly own: ReadonlyMap<string, SmsLine | null> = new Map(),
  ) {}

  lineFor(campaignTenantId: string | null, recipientTenantId: string, ownerTenantId: string | null): SmsLineAnswer {
    if (platformOwnersOwn(campaignTenantId, recipientTenantId, ownerTenantId)) return ready(this.platform);
    if (
      campaignTenantId !== null &&
      campaignTenantId !== ownerTenantId &&
      campaignTenantId === recipientTenantId &&
      this.own.has(campaignTenantId)
    ) {
      return ready(this.own.get(campaignTenantId) ?? null);
    }
    return { kind: 'none' };
  }
}

function ready(line: SmsLine | null): SmsLineAnswer {
  return line ? { kind: 'ready', line } : { kind: 'stalled' };
}

/** The `tenant_sms_config` rows this service reads: whose line is their own. */
type SmsConfigDb = { tenantSmsConfig: Pick<CrossTenantPrismaService['tenantSmsConfig'], 'findMany' | 'findFirst'> };

const OWN_LINE = { mode: TenantSmsMode.own_credentials, isActive: true } as const;
const CALLER = 'notification:SmsLineSource';

/**
 * Opens a delivery run's {@link SmsLineResolver} from the vault (F-018-a), and
 * answers the draft's "may this tenant send SMS on its own line" (F-035-i-a).
 *
 * No URL, no vault, no owner or no key is no line, and SMS rows stall as they
 * did with an empty `SMS_API_KEY`. A vault that fails to read is logged and
 * stalls them too: an outage delays a campaign rather than burning it. Each
 * tenant's line fails alone.
 *
 * `tenant_sms_config` is read on the cross-tenant pool the vault already runs
 * on: a delivery run has no request tenant, and the draft asks only about the
 * caller's own tenant and reads no value.
 */
@Injectable()
export class SmsLineSource {
  private readonly logger = new Logger(SmsLineSource.name);
  private readonly apiUrl: string;

  constructor(
    config: ConfigService,
    private readonly vault: CredentialVaultService,
    private readonly db: SmsConfigDb,
    private readonly providerFor: (apiUrl: string, apiKey: string) => Pick<SmsProviderService, 'sendSMS'> = (url, key) =>
      new SmsProviderService(url, key),
  ) {
    this.apiUrl = config.get<string>('SMS_API_URL', '');
  }

  /**
   * @param ownerTenantId the platform owner, when a run holds one of its SMS campaigns; else `null`.
   * @param resellerTenantIds the other tenants whose SMS campaigns the run holds.
   */
  async resolverFor(ownerTenantId: string | null, resellerTenantIds: readonly string[] = []): Promise<SmsLineResolver> {
    const platform = ownerTenantId ? await this.open(ownerTenantId, 'the platform SMS line') : null;
    const candidates = [...new Set(resellerTenantIds)].filter((id) => id !== ownerTenantId);
    const own = new Map<string, SmsLine | null>();
    if (candidates.length > 0) {
      const configured = await this.db.tenantSmsConfig.findMany({
        where: { tenantId: { in: candidates }, ...OWN_LINE },
        select: { tenantId: true },
      });
      for (const { tenantId } of configured) own.set(tenantId, await this.open(tenantId, `tenant ${tenantId}'s own SMS line`));
    }
    return new SmsLineResolver(platform, own);
  }

  /** The draft's question: an own, active line with a usable key. From the summary — nothing decrypted or audited. */
  async ownLineAvailable(tenantId: string): Promise<boolean> {
    const config = await this.db.tenantSmsConfig.findFirst({ where: { tenantId, ...OWN_LINE }, select: { tenantId: true } });
    return !!config && (await smsLineConfigured(this.vault, tenantId));
  }

  private async open(tenantId: string, what: string): Promise<SmsLine | null> {
    if (!this.apiUrl || !this.vault.available) return null;
    try {
      const line = await smsLineCredentials(this.vault, tenantId, CALLER);
      return line ? platformSmsLine(this.providerFor(this.apiUrl, line.apiKey), line.sender) : null;
    } catch (error) {
      this.logger.warn(`${what} could not be read from the vault: ${error instanceof Error ? error.name : 'error'}`);
      return null;
    }
  }
}
