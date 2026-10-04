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
 * guest reads them too; nothing here names a user.
 */
@Injectable()
export class GuideApiClient {
  private readonly logger = new Logger(GuideApiClient.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = (config.get<string>('TENANT_INTERNAL_BASE_URL') ?? '').replace(/\/+$/, '');
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
