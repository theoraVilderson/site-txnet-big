import { Injectable } from '@nestjs/common';
import { Language, Prisma } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import { ConversationRefused, SupportCaller } from '../conversations/refusal';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Canned replies (F-033-j, catalog §11.3): a short key and a text per
 * language, which an agent inserts into a reply and may still edit before
 * sending. Nothing about inserting one is stored — the reply is an ordinary
 * message.
 *
 * Owned like categories (ADR-0112 point 5, invariant 4): `tenantId` NULL is the
 * platform's defaults every tenant reads; a tenant's own reply with the same
 * key hides that default — retiring its own copy is how a tenant drops one.
 * Written by `support.manage`, used by `support.agent` (user, 2026-10-03).
 *
 * Variables are filled in the conversation user's language when inserted,
 * never stored filled. A text naming a variable outside the four is refused
 * when saved, so a typo never reaches a user.
 */

export const CANNED_VARIABLES = ['user.name', 'agent.name', 'tenant.name', 'conversation.subject'] as const;
export type CannedVariable = (typeof CANNED_VARIABLES)[number];

/** `{word.word}` — anything else in braces is just text. */
const VARIABLE = /\{([a-z]+\.[a-z]+)\}/g;

export const CANNED_BODY_MAX = 4000;
export const CANNED_KEY = /^[a-z0-9_]{1,40}$/;

/** The variables in `body` that are not one of the four, in order of appearance. */
export function unknownVariables(body: string): string[] {
  return [...body.matchAll(VARIABLE)].map((m) => m[1]).filter((v) => !(CANNED_VARIABLES as readonly string[]).includes(v));
}

/** One pass, so a filled value is never read as a variable again. Unknown ones stay as written. */
export function renderCanned(body: string, values: Record<CannedVariable, string>): string {
  return body.replace(VARIABLE, (whole, name: string) => (name in values ? values[name as CannedVariable] : whole));
}

/** The text in `lang`, else in the reference language, else any. */
export function textIn(texts: { lang: Language; body: string }[], lang: string): string | undefined {
  return texts.find((t) => t.lang === lang)?.body ?? texts.find((t) => t.lang === Language.fa)?.body ?? texts[0]?.body;
}

export interface CannedPick {
  id: string;
  key: string;
  /** In the agent's language — the picker's label; the inserted text is the user's. */
  body: string;
  source: 'tenant' | 'platform';
}

export interface CannedView {
  id: string;
  key: string;
  sortOrder: number;
  isActive: boolean;
  texts: { lang: Language; body: string }[];
}

export interface CannedInput {
  key: string;
  sortOrder?: number;
  isActive?: boolean;
  texts: { lang: Language; body: string }[];
}

type CannedRow = Prisma.SupportCannedReplyGetPayload<{ include: { texts: true } }>;

const ORDER = [{ sortOrder: 'asc' as const }, { key: 'asc' as const }];

@Injectable()
export class SupportCannedReplies {
  constructor(private readonly prisma: PrismaService) {}

  /** The agent's picker: the tenant's active replies and the platform's whose key it has not taken. */
  async picker(caller: SupportCaller, lang: string): Promise<CannedPick[]> {
    return tenantTransaction(this.prisma, async (tx) => {
      const rows = await tx.supportCannedReply.findMany({ include: { texts: true }, orderBy: ORDER });
      const own = new Set(rows.filter((r) => r.tenantId === caller.tenantId).map((r) => r.key));
      return rows
        .filter((r) => r.isActive && (r.tenantId === caller.tenantId || (r.tenantId === null && !own.has(r.key))))
        .map((r) => ({ id: r.id, key: r.key, body: textIn(r.texts, lang) ?? '', source: r.tenantId ? 'tenant' : 'platform' }));
    });
  }

  /**
   * One reply, filled for one conversation in its user's language. RLS keeps
   * both to the agent's tenant (and the platform's defaults); another tenant's
   * conversation or reply answers as a missing one.
   */
  async render(caller: SupportCaller, conversationId: string, replyId: string): Promise<{ body: string; lang: Language }> {
    return tenantTransaction(this.prisma, async (tx) => {
      const conversation = await tx.supportConversation.findFirst({
        where: { id: conversationId },
        select: { userId: true, subject: true },
      });
      if (!conversation) throw new ConversationRefused('not_found');
      const reply = await tx.supportCannedReply.findFirst({ where: { id: replyId, isActive: true }, include: { texts: true } });
      if (!reply) throw new ConversationRefused('canned_unknown');

      const [user, agent, branding, tenant] = await Promise.all([
        tx.user.findFirst({ where: { id: conversation.userId }, select: { fullName: true, languagePreference: true } }),
        tx.user.findFirst({ where: { id: caller.userId }, select: { fullName: true } }),
        tx.tenantBranding.findFirst({ where: { tenantId: caller.tenantId }, select: { brandName: true } }),
        tx.tenant.findUnique({ where: { id: caller.tenantId }, select: { slug: true } }),
      ]);
      const lang = user?.languagePreference ?? Language.fa;
      return {
        lang,
        body: renderCanned(textIn(reply.texts, lang) ?? '', {
          'user.name': user?.fullName ?? '',
          'agent.name': agent?.fullName ?? '',
          'tenant.name': branding?.brandName ?? tenant?.slug ?? '',
          'conversation.subject': conversation.subject,
        }),
      };
    });
  }

  /** The tenant's own replies, retired ones included, every language. The platform's defaults are not the tenant's to edit. */
  async own(tenantId: string): Promise<CannedView[]> {
    return tenantTransaction(this.prisma, async (tx) => {
      const rows = await tx.supportCannedReply.findMany({ where: { tenantId }, include: { texts: true }, orderBy: ORDER });
      return rows.map(viewOf);
    });
  }

  async create(tenantId: string, input: CannedInput): Promise<CannedView> {
    assertTexts(input.texts);
    return tenantTransaction(this.prisma, async (tx) => {
      if (await tx.supportCannedReply.findFirst({ where: { tenantId, key: input.key }, select: { id: true } })) {
        throw new ConversationRefused('canned_key_taken');
      }
      const row = await tx.supportCannedReply.create({
        data: {
          tenantId,
          key: input.key,
          sortOrder: input.sortOrder ?? 0,
          isActive: input.isActive ?? true,
          texts: { create: input.texts.map((t) => ({ tenantId, lang: t.lang, body: t.body })) },
        },
        include: { texts: true },
      });
      return viewOf(row);
    });
  }

  /** `texts`, when given, replaces every language at once. */
  async update(tenantId: string, id: string, input: Partial<CannedInput>): Promise<CannedView> {
    if (input.texts) assertTexts(input.texts);
    return tenantTransaction(this.prisma, async (tx) => {
      const row = await tx.supportCannedReply.findFirst({ where: { id, tenantId }, select: { id: true, key: true } });
      if (!row) throw new ConversationRefused('canned_unknown');
      if (input.key && input.key !== row.key && (await tx.supportCannedReply.findFirst({ where: { tenantId, key: input.key }, select: { id: true } }))) {
        throw new ConversationRefused('canned_key_taken');
      }
      if (input.texts) {
        await tx.supportCannedReplyText.deleteMany({ where: { cannedReplyId: id } });
        await tx.supportCannedReplyText.createMany({ data: input.texts.map((t) => ({ cannedReplyId: id, tenantId, lang: t.lang, body: t.body })) });
      }
      const updated = await tx.supportCannedReply.update({
        where: { id },
        data: { key: input.key, sortOrder: input.sortOrder, isActive: input.isActive },
        include: { texts: true },
      });
      return viewOf(updated);
    });
  }

  /** Nothing refers to a canned reply — an inserted one is an ordinary message — so it may simply go. */
  async remove(tenantId: string, id: string): Promise<void> {
    await tenantTransaction(this.prisma, async (tx) => {
      const { count } = await tx.supportCannedReply.deleteMany({ where: { id, tenantId } });
      if (count === 0) throw new ConversationRefused('canned_unknown');
    });
  }
}

/** At least one language, each once, none with an unknown variable. */
function assertTexts(texts: { lang: Language; body: string }[]): void {
  const langs = new Set(texts.map((t) => t.lang));
  if (texts.length === 0 || langs.size !== texts.length || texts.some((t) => unknownVariables(t.body).length > 0)) {
    throw new ConversationRefused('canned_invalid');
  }
}

function viewOf(r: CannedRow): CannedView {
  return {
    id: r.id,
    key: r.key,
    sortOrder: r.sortOrder,
    isActive: r.isActive,
    texts: r.texts.map((t) => ({ lang: t.lang, body: t.body })).sort((a, b) => a.lang.localeCompare(b.lang)),
  };
}
