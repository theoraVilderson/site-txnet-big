import { RequestHeaders } from '@txnet-backend/shared-core';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiResult } from '../auth-api/auth-api.types';
import { BotCopy } from '../locale/bot-copy';
import { BotKeys } from '../locale/bot-keys';

/** support's `ConversationStatus` (`support/contract.md`). */
export type SupportStatus = 'open' | 'pending_agent' | 'pending_user' | 'resolved' | 'closed';
/** support's `MessageSenderKind`. */
export type SupportSenderKind = 'user' | 'agent' | 'system' | 'bot' | 'ai';

/** A summary as `GET /api/support/conversations` lists it, narrowed to what the chat tells. */
export interface SupportConversation {
  id: string;
  subject: string;
  status: SupportStatus;
  lastSeq: number;
  unread: number;
  rating: { score: number } | null;
}

export interface SupportAttachment {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  scanStatus: 'pending' | 'clean' | 'infected' | 'failed';
  expired: boolean;
}

export interface SupportMessage {
  id: string;
  seq: number;
  senderKind: SupportSenderKind;
  mine: boolean;
  body: string;
  attachments: SupportAttachment[];
}

/** `GET …/conversations/:id/messages` — the latest page, oldest first. */
export interface SupportThread {
  conversation: SupportConversation;
  messages: SupportMessage[];
  hasEarlier: boolean;
}

export interface SupportCategory {
  id: string;
  key: string;
  name: string;
}

/** One file going up, as the messenger handed it over. */
export interface OutgoingFile {
  fileName: string;
  contentType: string;
  bytes: Buffer;
}

/** A file coming down (`GET …/attachments/:attachmentId`), to be sent into the chat. */
export interface DownloadedFile {
  fileName: string;
  contentType: string;
  bytes: Buffer;
}

export interface SupportCallContext {
  lang: string;
  accessToken: string;
}

/**
 * The user's support routes (F-309), **through the gate** — the panel's own
 * `/api/support/*`, so the chat and the panel hold one conversation, not two
 * (ADR-0009, ADR-0112). support decides everything: which threads are this
 * user's, what may be sent, what a status means. Unset, the member menu has
 * no support row.
 */
@Injectable()
export class SupportApiClient {
  private readonly logger = new Logger(SupportApiClient.name);
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(
    config: ConfigService,
    private readonly copy: BotCopy,
  ) {
    this.baseUrl = (config.get<string>('SUPPORT_API_BASE_URL') ?? '').replace(/\/+$/, '');
    this.serviceToken = config.get<string>('SERVICE_AUTH_TOKEN', '');
    this.timeoutMs = config.get<number>('AUTH_API_TIMEOUT_MS', 8000);
  }

  get isConfigured(): boolean {
    return this.baseUrl !== '';
  }

  conversations(ctx: SupportCallContext): Promise<ApiResult<{ items: SupportConversation[] }>> {
    return this.json('GET', '/api/support/conversations?limit=10', undefined, ctx);
  }

  categories(ctx: SupportCallContext): Promise<ApiResult<SupportCategory[]>> {
    return this.json('GET', '/api/support/categories', undefined, ctx);
  }

  open(body: { body: string; categoryId?: string }, ctx: SupportCallContext): Promise<ApiResult<SupportConversation>> {
    return this.json('POST', '/api/support/conversations', body, ctx);
  }

  /** The latest page — what the chat shows of a thread. */
  thread(id: string, ctx: SupportCallContext): Promise<ApiResult<SupportThread>> {
    return this.json('GET', `${this.path(id)}/messages?limit=6`, undefined, ctx);
  }

  send(id: string, body: string, ctx: SupportCallContext): Promise<ApiResult<SupportMessage>> {
    return this.json('POST', `${this.path(id)}/messages`, { body }, ctx);
  }

  read(id: string, upToSeq: number, ctx: SupportCallContext): Promise<ApiResult<{ lastReadSeq: number }>> {
    return this.json('POST', `${this.path(id)}/read`, { upToSeq }, ctx);
  }

  rate(id: string, score: number, ctx: SupportCallContext): Promise<ApiResult<{ score: number }>> {
    return this.json('POST', `${this.path(id)}/rating`, { score }, ctx);
  }

  reopen(id: string, ctx: SupportCallContext): Promise<ApiResult<{ id: string; status: SupportStatus }>> {
    return this.json('POST', `${this.path(id)}/reopen`, undefined, ctx);
  }

  /** Multipart, as the panel sends it (`files` repeated, `body` optional). */
  upload(id: string, files: OutgoingFile[], body: string | undefined, ctx: SupportCallContext): Promise<ApiResult<SupportMessage>> {
    const form = new FormData();
    for (const f of files) form.append('files', new Blob([new Uint8Array(f.bytes)], { type: f.contentType }), f.fileName);
    if (body) form.append('body', body);
    return this.request('POST', `${this.path(id)}/attachments`, form, ctx, async (r) => (await r.json()) as ApiResult<SupportMessage>);
  }

  /** The file's bytes (F-309): a refusal is the ordinary envelope, a file is the body itself. */
  attachment(id: string, attachmentId: string, ctx: SupportCallContext): Promise<ApiResult<DownloadedFile>> {
    return this.request('GET', `${this.path(id)}/attachments/${encodeURIComponent(attachmentId)}`, undefined, ctx, async (r) => {
      if ((r.headers.get('content-type') ?? '').startsWith('application/json')) return (await r.json()) as ApiResult<DownloadedFile>;
      if (!r.ok) return { ok: false, msg: '' };
      return {
        ok: true,
        msg: 'ok',
        data: {
          fileName: fileNameOf(r.headers.get('content-disposition')) ?? 'file',
          contentType: r.headers.get('content-type') ?? 'application/octet-stream',
          bytes: Buffer.from(await r.arrayBuffer()),
        },
      };
    });
  }

  private path(id: string): string {
    return `/api/support/conversations/${encodeURIComponent(id)}`;
  }

  private json<T>(method: 'GET' | 'POST', path: string, body: unknown, ctx: SupportCallContext): Promise<ApiResult<T>> {
    return this.request(method, path, body === undefined ? undefined : JSON.stringify(body), ctx, async (r) => (await r.json()) as ApiResult<T>);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: string | FormData | undefined,
    ctx: SupportCallContext,
    read: (r: Response) => Promise<ApiResult<T>>,
  ): Promise<ApiResult<T>> {
    if (!this.isConfigured) return this.unreachable(ctx.lang);
    const route = path.split('?')[0];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let envelope: ApiResult<T>;
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          // A FormData body sets its own boundary; naming the type here would drop it.
          ...(typeof body === 'string' ? { 'content-type': 'application/json' } : {}),
          'accept-language': ctx.lang,
          authorization: `Bearer ${ctx.accessToken}`,
          [RequestHeaders.serviceToken]: this.serviceToken,
        },
        ...(body === undefined ? {} : { body }),
        signal: controller.signal,
      });
      try {
        envelope = await read(response);
      } catch {
        this.logger.error(`support ${method} ${route} answered ${response.status} with an unreadable body`);
        return this.unreachable(ctx.lang);
      }
    } catch (e: unknown) {
      this.logger.error(`support ${method} ${route} failed: ${e instanceof Error ? e.message : String(e)}`);
      return this.unreachable(ctx.lang);
    } finally {
      clearTimeout(timer);
    }
    // A refusal the gate wrote rather than support carries no translated `msg`.
    if (typeof envelope?.ok !== 'boolean' || (!envelope.ok && !envelope.msg)) {
      this.logger.error(`support ${method} ${route} answered with no envelope`);
      return this.unreachable(ctx.lang);
    }
    return envelope;
  }

  /** The same failure shape as every other client's: a sentence, never a key. */
  private unreachable<T>(lang: string): ApiResult<T> {
    return { ok: false, msg: this.copy.text(lang, { key: BotKeys.common.tryAgain }) };
  }
}

/** `attachment; filename*=UTF-8''…` first, else the plain `filename="…"`. */
export function fileNameOf(disposition: string | null): string | null {
  if (!disposition) return null;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star) {
    try {
      return decodeURIComponent(star[1]);
    } catch {
      // fall through to the plain form
    }
  }
  const plain = /filename="([^"]*)"/i.exec(disposition);
  return plain ? plain[1] : null;
}
