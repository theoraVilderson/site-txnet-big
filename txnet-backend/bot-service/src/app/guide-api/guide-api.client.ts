import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequestHeaders, type GuideBlock } from '@txnet-backend/shared-core';

/** tenant-service's `ResolvedGuide`, the parts a chat shows. */
export interface BotGuide {
  key: string;
  kind: string;
  lang: string;
  title: string;
  blocks: GuideBlock[];
}

/** tenant-service's `GuideHit`: a guide a search found, read by key to show it. */
export interface GuideHitForBot {
  key: string;
  kind: string;
  lang: string;
  title: string;
  snippet: string;
}

export type GuideRead<T> = { ok: true } & T | { ok: false };

/**
 * The bot's way to a tenant's guides (F-414-f): tenant-service's
 * `GET /api/internal/guides` — the panel's own resolver, cache and ETag
 * (`guide/contract.md`), named by tenant rather than by Host, because a bot
 * knows its tenant (the integration's) and not the panel domain a reseller
 * serves on. In-network, with the service token, as billing's relay is.
 *
 * `TENANT_INTERNAL_BASE_URL` is optional: unset, no menu offers guides
 * (`isConfigured`), rather than a row that fails. A guide is public, so a
 * guest reads them too; only a vote names a user, by its token (F-414-l).
 */
@Injectable()
export class GuideApiClient {
  private readonly logger = new Logger(GuideApiClient.name);
  private readonly baseUrl: string;
  /** The gateway, for a vote: it needs the user's token, so `forward-auth` says whose (F-414-l). */
  private readonly gatewayUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = (config.get<string>('TENANT_INTERNAL_BASE_URL') ?? '').replace(/\/+$/, '');
    this.gatewayUrl = (config.get<string>('TENANT_API_BASE_URL') ?? '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('AUTH_API_TIMEOUT_MS', 8000);
  }

  get isConfigured(): boolean {
    return this.baseUrl !== '';
  }

  /** The guides placed in one slot for the bot, by their order. */
  async forSlot(tenantId: string, targetKind: string, targetRef: string, lang: string): Promise<GuideRead<{ guides: BotGuide[] }>> {
    const query = new URLSearchParams({ tenantId, placement: `${targetKind}:${targetRef}`, surface: 'bot' });
    const data = await this.get<{ guides: BotGuide[] }>(`/api/internal/guides?${query}`, lang);
    return data ? { ok: true, guides: data.guides } : { ok: false };
  }

  /** One guide by key; `guide: null` when this tenant sees none. */
  async one(tenantId: string, key: string, lang: string): Promise<GuideRead<{ guide: BotGuide | null }>> {
    const query = new URLSearchParams({ tenantId });
    const data = await this.get<{ guide: BotGuide | null }>(`/api/internal/guides/${encodeURIComponent(key)}?${query}`, lang);
    return data ? { ok: true, guide: data.guide } : { ok: false };
  }

  /**
   * The guides a support message may be answered by (F-414-k): any meaningful
   * word of it, ranked (`match=any`), for the bot. The text is cut to the
   * search's 100 characters — the start of a message says what it is about.
   */
  async search(tenantId: string, text: string, lang: string): Promise<GuideRead<{ hits: GuideHitForBot[] }>> {
    const q = text.replace(/\s+/g, ' ').trim().slice(0, 100);
    if (q.length < 2) return { ok: true, hits: [] };
    const query = new URLSearchParams({ tenantId, q, surface: 'bot', match: 'any' });
    const data = await this.get<{ hits: GuideHitForBot[] }>(`/api/internal/guide-search?${query}`, lang);
    return data ? { ok: true, hits: data.hits } : { ok: false };
  }

  /**
   * A guide this bot sent (F-414-l, ADR-0119): tenant-service counts it once a
   * day per chat. Never thrown and never waited on by a screen — a lost view
   * costs a number, not a reply.
   */
  async view(tenantId: string, key: string, chat: string, lang: string): Promise<void> {
    if (!this.isConfigured) return;
    try {
      const response = await fetch(`${this.baseUrl}/api/internal/guides/${encodeURIComponent(key)}/view?${new URLSearchParams({ tenantId })}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'accept-language': lang, [RequestHeaders.serviceToken]: this.serviceToken },
        body: JSON.stringify({ viewer: chat }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) this.logger.warn(`guide view answered ${response.status}`);
    } catch (e: unknown) {
      this.logger.warn(`guide view failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  get canVote(): boolean {
    return this.gatewayUrl !== '';
  }

  /**
   * A signed-in chat's vote (F-414-l): `PUT /api/guides/feedback/:key` through
   * the gateway with the user's own token, as the panel's — one vote per user,
   * the last one kept. `false` for anything the chat can only retry.
   */
  async vote(key: string, helpful: boolean, accessToken: string, lang: string): Promise<boolean> {
    if (!this.canVote) return false;
    try {
      const response = await fetch(`${this.gatewayUrl}/api/guides/feedback/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'accept-language': lang,
          authorization: `Bearer ${accessToken}`,
          [RequestHeaders.serviceToken]: this.serviceToken,
        },
        body: JSON.stringify({ helpful }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) this.logger.error(`guide vote answered ${response.status}`);
      return response.ok;
    } catch (e: unknown) {
      this.logger.error(`guide vote failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** The envelope's data; `null` for anything a screen can only answer with "try again". */
  private async get<T>(path: string, lang: string): Promise<T | null> {
    if (!this.isConfigured) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        headers: { 'accept-language': lang, [RequestHeaders.serviceToken]: this.serviceToken },
        signal: controller.signal,
      });
      const envelope = (await response.json().catch((): null => null)) as { ok?: boolean; data?: T } | null;
      if (!response.ok || envelope?.ok !== true || envelope.data === undefined) {
        this.logger.error(`guides ${path.split('?')[0]} answered ${response.status}`);
        return null;
      }
      return envelope.data;
    } catch (e: unknown) {
      this.logger.error(`guides ${path.split('?')[0]} failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
