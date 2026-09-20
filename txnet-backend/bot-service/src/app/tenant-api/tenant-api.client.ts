import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiResult } from '../auth-api/auth-api.types';
import { BotCopy } from '../locale/bot-copy';
import { BotKeys } from '../locale/bot-keys';

/**
 * The door's own verdict on one reseller (`tenant/contract.entitlements.md`,
 * F-311-e): may this caller administer it, and may they change anything there.
 *
 * `reason` is set only when nothing is allowed, and it is the door's — relayed
 * to a screen, never widened by one.
 */
export interface TenantAccessVerdict {
  tenantId: string;
  canRead: boolean;
  canWrite: boolean;
  reason: string | null;
}

/** Whose call this is: the chat's access token, in the chat's language. */
export interface TenantCallContext {
  lang: string;
  accessToken: string;
}

/**
 * The bot's way into `tenant-service` — one route, `GET /api/tenants/:id/access`.
 *
 * It exists because the bot cannot tell a reseller's owner from one of its
 * customers: the owner signs in in their own platform tenant (ADR-0059 (6)),
 * so neither the session nor `/auth/me` names the reseller whose bot this is.
 * Asking the door is the only answer that stays true when the permission model
 * moves — deriving it from a data route's refusal answers "give me", not
 * "may I" (F-311-c, the two rejected options).
 *
 * **Through the gate**, exactly as `BillingApiClient` reaches billing: the
 * route reads the identity headers `my-auth` writes, so the chat's access
 * token is the Bearer and nothing here names a user or a tenant. The service
 * token rides along for the same reason it does everywhere else — it says
 * which service is calling, never on whose behalf.
 *
 * `TENANT_API_BASE_URL` is optional: unset, the member menu has no management
 * row rather than one that fails (`isConfigured`).
 */
@Injectable()
export class TenantApiClient {
  private readonly logger = new Logger(TenantApiClient.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(
    config: ConfigService,
    private readonly copy: BotCopy,
  ) {
    this.baseUrl = (config.get<string>('TENANT_API_BASE_URL') ?? '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('AUTH_API_TIMEOUT_MS', 8000);
  }

  get isConfigured(): boolean {
    return this.baseUrl !== '';
  }

  /**
   * The verdict, for the reseller this bot serves.
   *
   * Nothing is cached, and the reason is the same one ADR-0033 gives for the
   * session: a seat revoked a second ago must stop administering, and a
   * remembered "yes" is a menu row that fails on its first tap.
   */
  access(tenantId: string, ctx: TenantCallContext): Promise<ApiResult<TenantAccessVerdict>> {
    return this.send(`/api/tenants/${tenantId}/access`, ctx);
  }

  private async send(path: string, ctx: TenantCallContext): Promise<ApiResult<TenantAccessVerdict>> {
    if (!this.isConfigured) return this.unreachable(ctx.lang);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'GET',
        headers: {
          'content-type': 'application/json',
          'accept-language': ctx.lang,
          authorization: `Bearer ${ctx.accessToken}`,
          [RequestHeaders.serviceToken]: this.serviceToken,
        },
        signal: controller.signal,
      });
    } catch (e: unknown) {
      this.logger.error(`tenant-api GET ${path} failed: ${e instanceof Error ? e.message : String(e)}`);
      return this.unreachable(ctx.lang);
    } finally {
      clearTimeout(timer);
    }

    let envelope: ApiResult<TenantAccessVerdict>;
    try {
      envelope = (await response.json()) as ApiResult<TenantAccessVerdict>;
    } catch {
      this.logger.error(`tenant-api GET ${path} answered ${response.status} with a non-JSON body`);
      return this.unreachable(ctx.lang);
    }
    if (typeof envelope?.ok !== 'boolean' || (!envelope.ok && !envelope.msg)) {
      this.logger.error(`tenant-api GET ${path} answered ${response.status} with no envelope`);
      return this.unreachable(ctx.lang);
    }
    return envelope;
  }

  /** The same failure shape as every other client's: a sentence, never a key. */
  private unreachable(lang: string): ApiResult<TenantAccessVerdict> {
    return { ok: false, msg: this.copy.text(lang, { key: BotKeys.common.tryAgain }) };
  }
}
