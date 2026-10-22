import { Prisma, type SocialPlatform } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';

import type { PrismaService } from '../../prisma/prisma.service';
import { TenantContext } from '../../tenant-context/tenant-context';

/*
 * Every write of a `linked_bot_account` but the unlink: a proof (invariant
 * #12 — a contact card, a registration's parked proof) and an import's claim
 * (F-210, ADR-0157). A claim carries nothing until proved, and never outranks
 * a proof: it is released by one for another person and redeemed by the
 * chat's own card.
 */

/** What an import's claim came to (F-210): written, or why not. Declared once (C-09). */
export const CHAT_CLAIM_OUTCOMES = ['claimed', 'taken', 'has_other'] as const;
export type ChatClaimOutcome = (typeof CHAT_CLAIM_OUTCOMES)[number];
export type ChatClaim = { userId: string; chatId: string };
export type ProvenLink = { userId: string; platform: SocialPlatform; chatId: string; phoneNumber: string };

/** A link that is a claim and nothing more: an import wrote it and no card proved it. */
const UNPROVEN_CLAIM: Prisma.LinkedBotAccountWhereInput = { claimedAt: { not: null }, contactVerifiedAt: null };

/**
 * Writes each person's claim on the chat the source named, in the caller's
 * transaction (the import's, under its lock). A chat linked to anyone else —
 * claimed or proved, before or earlier in the batch — is `taken` and never
 * moved; a person already linked to another chat keeps it (`has_other`); a
 * re-run finds its own claim and writes nothing.
 */
export async function claimChats(tx: Prisma.TransactionClient, tenantId: string, platform: SocialPlatform, claims: ChatClaim[]): Promise<Map<string, ChatClaimOutcome>> {
  const outcome = new Map<string, ChatClaimOutcome>();
  if (claims.length === 0) return outcome;
  const held = await tx.linkedBotAccount.findMany({
    where: { tenantId, platform, OR: [{ userId: { in: claims.map((c) => c.userId) } }, { platformUserId: { in: claims.map((c) => c.chatId) } }] },
    select: { userId: true, platformUserId: true },
  });
  const chatOf = new Map(held.map((l) => [l.userId, l.platformUserId]));
  const holderOf = new Map(held.map((l) => [l.platformUserId, l.userId]));
  const now = new Date();
  const fresh: Prisma.LinkedBotAccountCreateManyInput[] = [];
  for (const { userId, chatId } of claims) {
    if (outcome.has(userId)) continue;
    const own = chatOf.get(userId);
    if (own !== undefined) outcome.set(userId, own === chatId ? 'claimed' : 'has_other');
    else if (holderOf.has(chatId)) outcome.set(userId, 'taken');
    else {
      fresh.push({ tenantId, userId, platform, platformUserId: chatId, claimedAt: now });
      chatOf.set(userId, chatId);
      holderOf.set(chatId, userId);
      outcome.set(userId, 'claimed');
    }
  }
  if (fresh.length > 0) await tx.linkedBotAccount.createMany({ data: fresh });
  return outcome;
}

/** A proof for one person releases another's unproven claim on the chat (ADR-0157); a proved link is never released here. */
export async function releaseClaims(db: Prisma.TransactionClient, platform: SocialPlatform, chatId: string, provedUserId: string): Promise<void> {
  await db.linkedBotAccount.deleteMany({ where: { platform, platformUserId: chatId, userId: { not: provedUserId }, ...UNPROVEN_CLAIM } });
}

/** The proven link, in the ambient tenant: created, or the person's existing one moved to this chat and proved. */
export async function upsertProvenLink(db: Prisma.TransactionClient, link: ProvenLink): Promise<void> {
  const proved = { platformUserId: link.chatId, phoneNumber: link.phoneNumber, contactVerifiedAt: new Date() };
  await db.linkedBotAccount.upsert({
    where: { userId_platform: { userId: link.userId, platform: link.platform } },
    // Prisma's create input cannot know the ambient tenant `withTenant` would
    // inject (F-066-l), so the write names it: the person's own, by construction.
    create: { tenantId: TenantContext.current('a bot link').id, userId: link.userId, platform: link.platform, ...proved },
    update: proved,
  });
}

/** A proof's write where the caller has already checked the chat is no one else's proved link. */
export async function proveLink(db: Prisma.TransactionClient, link: ProvenLink): Promise<void> {
  await releaseClaims(db, link.platform, link.chatId, link.userId);
  await upsertProvenLink(db, link);
}

/**
 * The chat proved its own contact card and the card's phone is no one's in
 * the tenant: the person an import claimed this chat for takes that phone as
 * verified and the link is proved (ADR-0157). Only a person with no phone —
 * one who has a phone is decided by it. Null when there is no such claim, or
 * the person took a phone meanwhile.
 */
export async function redeemClaim(db: PrismaService, proof: { platform: SocialPlatform; chatId: string; phoneNumber: string }): Promise<string | null> {
  const claim = await db.linkedBotAccount.findFirst({
    where: { platform: proof.platform, platformUserId: proof.chatId, ...UNPROVEN_CLAIM, user: { phoneNumber: null, deletedAt: null } },
    select: { id: true, userId: true },
  });
  if (!claim) return null;
  const now = new Date();
  return tenantTransaction(db, async (tx) => {
    const took = await tx.user.updateMany({ where: { id: claim.userId, phoneNumber: null }, data: { phoneNumber: proof.phoneNumber, phoneVerifiedAt: now } });
    if (took.count === 0) return null;
    await tx.linkedBotAccount.update({ where: { id: claim.id }, data: { phoneNumber: proof.phoneNumber, contactVerifiedAt: now } });
    return claim.userId;
  });
}
