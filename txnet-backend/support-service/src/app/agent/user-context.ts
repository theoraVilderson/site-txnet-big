import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RequestHeaders, tenantTransaction } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { ConversationRefused, SupportCaller } from '../conversations/refusal';
import { PrismaService } from '../prisma/prisma.service';

/**
 * What billing answers about one user (its `SupportUserFacts`): wallet, current
 * Grants, recent invoices, last connection. Passed through as billing shaped
 * it — billing decides what of its data leaves (user, 2026-10-04).
 */
export type BillingUserFacts = Record<string, unknown>;

export interface BillingFactsSeam {
  of(tenantId: string, userId: string): Promise<BillingUserFacts>;
}

export const BILLING_FACTS_SEAM = Symbol('BILLING_FACTS_SEAM');

export type UserContext = { userId: string; billing: BillingUserFacts | null };

/**
 * The agent's sidebar (F-033-m, catalog §11.3): the conversation's user, as
 * billing sees them. The thread is found **in the caller's tenant** first
 * (RLS and the `tenantId` filter), and only then is billing asked — with that
 * tenant and the thread's own user, never an id from the request. A billing
 * that fails or is not configured answers `billing: null`: the sidebar is
 * empty, the conversation is not broken.
 */
@Injectable()
export class SupportUserContext {
  private readonly logger = new Logger(SupportUserContext.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(BILLING_FACTS_SEAM) private readonly billing: BillingFactsSeam,
  ) {}

  async forConversation(caller: SupportCaller, conversationId: string): Promise<UserContext> {
    const thread = await tenantTransaction(this.prisma, (tx) =>
      tx.supportConversation.findFirst({ where: { id: conversationId, tenantId: caller.tenantId }, select: { userId: true } }),
    );
    if (!thread) throw new ConversationRefused('not_found');
    try {
      return { userId: thread.userId, billing: await this.billing.of(caller.tenantId, thread.userId) };
    } catch (e) {
      this.logger.warn(`sidebar for conversation ${conversationId} without billing: ${(e as Error).message}`);
      return { userId: thread.userId, billing: null };
    }
  }
}

/** billing-service's `GET /api/internal/billing/tenants/:t/users/:u/support-context`, with `SERVICE_AUTH_TOKEN`. */
@Injectable()
export class HttpBillingFactsSeam implements BillingFactsSeam {
  private readonly baseUrl: string;
  private readonly serviceToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService<EnvConfig, true>) {
    this.baseUrl = config.get('BILLING_API_BASE_URL', { infer: true }).replace(/\/+$/, '');
    this.serviceToken = config.get('SERVICE_AUTH_TOKEN', { infer: true });
    this.timeoutMs = config.get('BILLING_API_TIMEOUT_MS', { infer: true });
  }

  async of(tenantId: string, userId: string): Promise<BillingUserFacts> {
    if (!this.baseUrl || !this.serviceToken) throw new Error('BILLING_API_BASE_URL or SERVICE_AUTH_TOKEN is not set');
    const response = await fetch(
      `${this.baseUrl}/api/internal/billing/tenants/${encodeURIComponent(tenantId)}/users/${encodeURIComponent(userId)}/support-context`,
      { headers: { [RequestHeaders.serviceToken]: this.serviceToken }, signal: AbortSignal.timeout(this.timeoutMs) },
    );
    if (!response.ok) throw new Error(`billing answered ${response.status}`);
    // billing's envelope (`{ok, msg, data}`): the facts are `data`.
    const body = (await response.json()) as { data?: BillingUserFacts };
    if (!body.data) throw new Error('billing answered no data');
    return body.data;
  }
}
