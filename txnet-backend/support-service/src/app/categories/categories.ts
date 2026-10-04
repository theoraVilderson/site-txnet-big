import { Injectable } from '@nestjs/common';
import { Language, Prisma } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import { ConversationRefused } from '../conversations/refusal';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A tenant's support categories (F-033-e, ADR-0112 point 6): a short key, an
 * order and a name per language. `tenantId` NULL is the platform's default
 * set, read-only to a tenant; **a tenant with any active category of its own
 * offers only its own**, and with none its users see the defaults again — no
 * seeding, no copy to keep in step. Written by `support.manage`.
 *
 * A category a conversation names is retired (`isActive`), never deleted, so a
 * thread's `categoryId` never points at nothing.
 */

export const CATEGORY_KEY = /^[a-z0-9_]{1,40}$/;
export const CATEGORY_NAME_MAX = 80;

export interface CategoryText {
  lang: Language;
  name: string;
}

export interface CategoryAdminView {
  id: string;
  key: string;
  sortOrder: number;
  isActive: boolean;
  texts: CategoryText[];
  /** A conversation names it: retire, never delete. */
  inUse: boolean;
}

export interface CategoryInput {
  key: string;
  sortOrder?: number;
  isActive?: boolean;
  texts: CategoryText[];
}

export interface CategoryList {
  /** The tenant's own, retired included. */
  own: CategoryAdminView[];
  /** The platform's defaults, named in the caller's language — what users see while `usingPlatform`. */
  platform: { id: string; key: string; name: string }[];
  /** The tenant has no active category of its own, so its users are offered `platform`. */
  usingPlatform: boolean;
}

type CategoryRow = Prisma.SupportCategoryGetPayload<{ include: { texts: true; _count: { select: { conversations: true } } } }>;

const ORDER = [{ sortOrder: 'asc' as const }, { key: 'asc' as const }];
const WITH = { texts: true, _count: { select: { conversations: true } } } as const;

@Injectable()
export class SupportCategories {
  constructor(private readonly prisma: PrismaService) {}

  async list(tenantId: string, lang: string): Promise<CategoryList> {
    return tenantTransaction(this.prisma, async (tx) => {
      const [own, platform] = await Promise.all([
        tx.supportCategory.findMany({ where: { tenantId }, include: WITH, orderBy: ORDER }),
        tx.supportCategory.findMany({ where: { tenantId: null, isActive: true }, include: { texts: true }, orderBy: ORDER }),
      ]);
      return {
        own: own.map(viewOf),
        platform: platform.map((c) => ({ id: c.id, key: c.key, name: nameIn(c.texts, lang) ?? c.key })),
        usingPlatform: !own.some((c) => c.isActive),
      };
    });
  }

  async create(tenantId: string, input: CategoryInput): Promise<CategoryAdminView> {
    assertTexts(input.texts);
    return tenantTransaction(this.prisma, async (tx) => {
      if (await tx.supportCategory.findFirst({ where: { tenantId, key: input.key }, select: { id: true } })) {
        throw new ConversationRefused('category_key_taken');
      }
      const row = await tx.supportCategory.create({
        data: {
          tenantId,
          key: input.key,
          sortOrder: input.sortOrder ?? 0,
          isActive: input.isActive ?? true,
          texts: { create: input.texts.map((t) => ({ tenantId, lang: t.lang, name: t.name })) },
        },
        include: WITH,
      });
      return viewOf(row);
    });
  }

  /** `texts`, when given, replaces every language at once. Only the tenant's own; a default answers as missing. */
  async update(tenantId: string, id: string, input: Partial<CategoryInput>): Promise<CategoryAdminView> {
    if (input.texts) assertTexts(input.texts);
    return tenantTransaction(this.prisma, async (tx) => {
      const row = await tx.supportCategory.findFirst({ where: { id, tenantId }, select: { id: true, key: true } });
      if (!row) throw new ConversationRefused('category_unknown');
      if (input.key && input.key !== row.key && (await tx.supportCategory.findFirst({ where: { tenantId, key: input.key }, select: { id: true } }))) {
        throw new ConversationRefused('category_key_taken');
      }
      if (input.texts) {
        await tx.supportCategoryText.deleteMany({ where: { categoryId: id } });
        await tx.supportCategoryText.createMany({ data: input.texts.map((t) => ({ categoryId: id, tenantId, lang: t.lang, name: t.name })) });
      }
      const updated = await tx.supportCategory.update({
        where: { id },
        data: { key: input.key, sortOrder: input.sortOrder, isActive: input.isActive },
        include: WITH,
      });
      return viewOf(updated);
    });
  }

  /** Only one no conversation names (ADR-0112 point 6); otherwise `category_in_use` — retire it. */
  async remove(tenantId: string, id: string): Promise<void> {
    await tenantTransaction(this.prisma, async (tx) => {
      const row = await tx.supportCategory.findFirst({ where: { id, tenantId }, select: { id: true } });
      if (!row) throw new ConversationRefused('category_unknown');
      if (await tx.supportConversation.findFirst({ where: { categoryId: id }, select: { id: true } })) {
        throw new ConversationRefused('category_in_use');
      }
      await tx.supportCategory.delete({ where: { id } });
    });
  }
}

/** The name in `lang`, else in the reference language, else any. */
export function nameIn(texts: { lang: Language; name: string }[], lang: string): string | undefined {
  return texts.find((t) => t.lang === lang)?.name ?? texts.find((t) => t.lang === Language.fa)?.name ?? texts[0]?.name;
}

/** At least one language, each once. */
function assertTexts(texts: CategoryText[]): void {
  if (texts.length === 0 || new Set(texts.map((t) => t.lang)).size !== texts.length) {
    throw new ConversationRefused('category_invalid');
  }
}

function viewOf(r: CategoryRow): CategoryAdminView {
  return {
    id: r.id,
    key: r.key,
    sortOrder: r.sortOrder,
    isActive: r.isActive,
    texts: r.texts.map((t) => ({ lang: t.lang, name: t.name })).sort((a, b) => a.lang.localeCompare(b.lang)),
    inUse: r._count.conversations > 0,
  };
}
