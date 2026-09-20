import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiResult } from '../auth-api/auth-api.types';
import { BotCopy } from '../locale/bot-copy';
import { BotKeys } from '../locale/bot-keys';

/**
 * Which channel a campaign goes out on. The bot picks its own messenger and
 * never anything else: the reseller is writing inside its Telegram bot, so the
 * broadcast is the Telegram one. `sms`, `email` and `push` are the panel's to
 * offer, and asking a chat to choose a delivery line is a screen that answers
 * a question the chat has already answered by existing.
 */
export type CampaignChannel = 'telegram_bot' | 'bale_bot';

/** Where a campaign is, as `notification` spells it (`CampaignStatus`). */
export type CampaignStatus = 'draft' | 'sending' | 'completed' | 'stopped';

/**
 * The audience of a campaign — notification's own closed shape
 * (`campaign-admin.schema.ts`, F-035-d), never widened here. Every key
 * narrows; an absent key does not, and `{}` is every user of the reseller.
 *
 * The bot spells only the keys it offers as a segment. A new key belongs to
 * that schema and the fan-out first (they are what read it), and to a bot
 * screen afterwards.
 */
export interface CampaignAudience {
  statuses?: ('active' | 'suspended' | 'banned')[];
  registeredFrom?: string;
}

/** One campaign, as this surface answers it (`CampaignView`, the fields a chat shows). */
export interface Campaign {
  id: string;
  channel: string;
  messageBody: string;
  status: CampaignStatus;
  sentCount: number;
  failedCount: number;
  createdAt: string;
}

export interface CampaignPage {
  items: Campaign[];
  total: number;
  page: number;
  pageSize: number;
}

/** What a draft is, apart from whose it is: the path names the reseller (F-313-d). */
export interface CampaignDraft {
  channel: CampaignChannel;
  messageBody: string;
  audience: CampaignAudience;
}

/** Whose call this is: the chat's access token, in the chat's language. */
export interface NotificationCallContext {
  lang: string;
  accessToken: string;
}

/**
 * The bot's way into `notification-service` — the reseller-named campaign
 * routes alone (`/api/notifications/tenants/:tenantId/campaigns…`, F-313-d).
 *
 * **The reseller is the path's, never the session's.** The owner signs in in
 * their own platform tenant (ADR-0059 (6), F-061-i), so the admin campaign
 * surface would draft for the platform — an audience of every tenant's users.
 * Which is why that surface is not the one this calls: `ResellerAccess` admits
 * the caller to the tenant the path names, and the bot names the tenant whose
 * webhook this update arrived on (`ctx.integration.tenantId`, F-320).
 *
 * **Through the gate**, as `TenantApiClient` and `BillingApiClient` are: the
 * route reads the identity headers `my-auth` writes, so the chat's access
 * token is the Bearer and the service token only says which service is
 * calling. `NOTIFICATION_API_BASE_URL` is optional — unset, the reseller panel
 * simply has no bulk-message row (`isConfigured`), rather than one that fails.
 */
@Injectable()
export class NotificationApiClient {
  private readonly logger = new Logger(NotificationApiClient.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(
    config: ConfigService,
    private readonly copy: BotCopy,
  ) {
    this.baseUrl = (config.get<string>('NOTIFICATION_API_BASE_URL') ?? '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('AUTH_API_TIMEOUT_MS', 8000);
  }

  get isConfigured(): boolean {
    return this.baseUrl !== '';
  }

  /**
   * How many of this reseller's users a segment reaches, before anything is
   * drafted. An estimate on screen and in the contract, because it is counted
   * now and the send starts later (`notification/contract.reseller.md`).
   */
  audienceCount(
    tenantId: string,
    audience: CampaignAudience,
    ctx: NotificationCallContext,
  ): Promise<ApiResult<{ count: number }>> {
    return this.send('POST', `${this.campaigns(tenantId)}/audience/count`, ctx, { audience });
  }

  /** Drafts one. The draft is the commitment, so it is a row there and an id here (ADR-0010). */
  draft(tenantId: string, body: CampaignDraft, ctx: NotificationCallContext): Promise<ApiResult<Campaign>> {
    return this.send('POST', this.campaigns(tenantId), ctx, body);
  }

  /** Starts the send: `draft -> sending`, and `worker-service` fans it out (F-035-d). */
  start(tenantId: string, id: string, ctx: NotificationCallContext): Promise<ApiResult<Campaign>> {
    return this.send('POST', `${this.campaigns(tenantId)}/${id}/send`, ctx);
  }

  /** Where one campaign has got to — the refresh behind "watch it go". */
  campaign(tenantId: string, id: string, ctx: NotificationCallContext): Promise<ApiResult<Campaign>> {
    return this.send('GET', `${this.campaigns(tenantId)}/${id}`, ctx);
  }

  /** This reseller's campaigns, newest first. A `read`, so a suspended reseller still sees them. */
  list(
    tenantId: string,
    query: { page: number; pageSize: number },
    ctx: NotificationCallContext,
  ): Promise<ApiResult<CampaignPage>> {
    return this.send('GET', `${this.campaigns(tenantId)}?page=${query.page}&pageSize=${query.pageSize}`, ctx);
  }

  private campaigns(tenantId: string): string {
    return `/api/notifications/tenants/${tenantId}/campaigns`;
  }

  private async send<T>(
    method: 'GET' | 'POST',
    path: string,
    ctx: NotificationCallContext,
    body?: unknown,
  ): Promise<ApiResult<T>> {
    if (!this.isConfigured) return this.unreachable(ctx.lang);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'accept-language': ctx.lang,
          authorization: `Bearer ${ctx.accessToken}`,
          [RequestHeaders.serviceToken]: this.serviceToken,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e: unknown) {
      this.logger.error(`notification-api ${method} ${path} failed: ${e instanceof Error ? e.message : String(e)}`);
      return this.unreachable(ctx.lang);
    } finally {
      clearTimeout(timer);
    }

    let envelope: ApiResult<T>;
    try {
      envelope = (await response.json()) as ApiResult<T>;
    } catch {
      this.logger.error(`notification-api ${method} ${path} answered ${response.status} with a non-JSON body`);
      return this.unreachable(ctx.lang);
    }
    if (typeof envelope?.ok !== 'boolean' || (!envelope.ok && !envelope.msg)) {
      this.logger.error(`notification-api ${method} ${path} answered ${response.status} with no envelope`);
      return this.unreachable(ctx.lang);
    }
    return envelope;
  }

  /** The same failure shape as every other client's: a sentence, never a key. */
  private unreachable<T>(lang: string): ApiResult<T> {
    return { ok: false, msg: this.copy.text(lang, { key: BotKeys.common.tryAgain }) };
  }
}
