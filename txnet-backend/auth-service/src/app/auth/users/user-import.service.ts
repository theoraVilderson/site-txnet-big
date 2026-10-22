import { randomBytes, randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { SocialPlatform, type Prisma } from '@prisma/client';
import { tenantTransaction } from '@txnet-backend/shared-core';
import * as argon2 from 'argon2';

import { PrismaService } from '../../prisma/prisma.service';
import { TenantContext } from '../../tenant-context/tenant-context';
import { claimChats, type ChatClaim, type ChatClaimOutcome } from '../bot-link/link-writes';
import { END_USER_ROLE_NAME, endUserRoom, lockEndUserRoom } from './end-user-room';

/** At most this many source clients per call (F-201-e), the size of a source link batch (F-201-b). */
export const USER_IMPORT_BATCH_MAX = 200;
/** The register form's username shape (`register.schema.ts`). */
const USERNAME_MIN = 3;
const USERNAME_MAX = 32;
const USERNAME_FALLBACK = 'user';
/** A label is a source panel's free text; only this much of it becomes a name. */
const FULL_NAME_MAX = 120;
const UNKNOWN_SECRET_BYTES = 32;

/** A source client's person; `telegramId` the account the source named for its bot user (F-210). */
export type SourceUser = { remoteIdentity: string; label: string; telegramId?: string };
export type ImportedUser = { remoteIdentity: string; userId: string; created: boolean; telegram?: ChatClaimOutcome };
export const USER_IMPORT_REFUSALS = ['over_cap', 'deleted'] as const;
export type RefusedUser = { remoteIdentity: string; reason: (typeof USER_IMPORT_REFUSALS)[number] };
export type UserImportAnswer = { users: ImportedUser[]; refused: RefusedUser[] };
/** Why a rollback's removal keeps a person (F-211): not an import's, or they did something here since. */
export const USER_REMOVAL_KEPT = ['not_found', 'not_imported', 'phone_linked', 'email_linked', 'messenger_linked', 'signed_in'] as const;
export type KeptUser = { userId: string; reason: (typeof USER_REMOVAL_KEPT)[number] };
export type UserRemovalAnswer = { removed: string[]; kept: KeptUser[] };
export type TelegramLinkAnswer = { links: Array<{ userId: string; telegram: ChatClaimOutcome }> };

type RemovalFacts = { remoteIdentity: string | null; phoneNumber: string | null; email: string | null; _count: { sessions: number; linkedBotAccounts: number } };

/** Why a person stays, or null when all they did was arrive by the import: no phone or email, no proven messenger (a claim is not one), never signed in. */
function keptBecause(user: RemovalFacts): KeptUser['reason'] | null {
  if (user.remoteIdentity === null) return 'not_imported';
  if (user.phoneNumber) return 'phone_linked';
  if (user.email) return 'email_linked';
  if (user._count.linkedBotAccounts > 0) return 'messenger_linked';
  if (user._count.sessions > 0) return 'signed_in';
  return null;
}

/**
 * A username from a source label: lower-cased, every run of characters the
 * register form refuses folded to one `_`, cut to 32. A label with too little
 * Latin in it (a Persian name) is `user`, or `user_<what is left>`; a clash is
 * `pickUsername`'s.
 */
export function usernameBase(label: string): string {
  const folded = label.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (folded.length >= USERNAME_MIN) return folded.slice(0, USERNAME_MAX);
  return folded ? `${USERNAME_FALLBACK}_${folded}` : USERNAME_FALLBACK;
}

/** The base itself if free, else `<base>_2`, `_3`, … cut so the suffix always fits. */
function pickUsername(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const name = `${base.slice(0, USERNAME_MAX - suffix.length)}${suffix}`;
    if (!taken.has(name)) return name;
  }
}

/**
 * Finds or creates the tenant's user for each source client of an import
 * (F-201-e, D-63; contract.import.md). Called by the commit (F-207).
 */
@Injectable()
export class UserImportService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * One transaction per batch, under the lock registration takes, so the
   * end-user cap and the usernames read here still hold at commit. A person
   * already imported is answered, never created again; one deleted since is
   * refused, never revived; past the cap each one left is refused, the rest
   * created. Nobody created has a phone or a password anyone knows: the hash
   * is of a secret discarded at once — they arrive by the bot (F-210) or by
   * linking a phone. No `USER_SIGNED_UP`: an import is not a signup.
   */
  async findOrCreate(batch: SourceUser[]): Promise<UserImportAnswer> {
    const tenantId = TenantContext.current('user import').id;
    const sources = [...new Map(batch.map((s) => [s.remoteIdentity, s])).values()];
    const role = await this.prisma.role.findFirst({ where: { name: END_USER_ROLE_NAME }, select: { id: true } });
    if (!role) throw new Error(`the ${END_USER_ROLE_NAME} role is not seeded`);
    // Hashed once per batch, outside the transaction: argon2 is the slow part.
    const passwordHash = await argon2.hash(randomBytes(UNKNOWN_SECRET_BYTES).toString('base64'), { type: argon2.argon2id });

    return tenantTransaction(this.prisma, async (tx) => {
      await lockEndUserRoom(tx, tenantId);
      const known = await tx.user.findMany({
        where: { tenantId, remoteIdentity: { in: sources.map((s) => s.remoteIdentity) } },
        select: { id: true, remoteIdentity: true, deletedAt: true },
      });
      const byIdentity = new Map(known.map((u) => [u.remoteIdentity, u]));
      const answer: UserImportAnswer = { users: [], refused: [] };
      const fresh: SourceUser[] = [];
      for (const source of sources) {
        const user = byIdentity.get(source.remoteIdentity);
        if (!user) fresh.push(source);
        else if (user.deletedAt) answer.refused.push({ remoteIdentity: source.remoteIdentity, reason: 'deleted' });
        else answer.users.push({ remoteIdentity: source.remoteIdentity, userId: user.id, created: false });
      }
      const room = fresh.length === 0 ? 0 : await endUserRoom(tx, tenantId);
      const admitted = room === null ? fresh : fresh.slice(0, room);
      for (const source of fresh.slice(admitted.length)) answer.refused.push({ remoteIdentity: source.remoteIdentity, reason: 'over_cap' });
      if (admitted.length > 0) {
        const rows = await this.newUsers(tx, { tenantId, roleId: role.id, passwordHash }, admitted);
        await tx.user.createMany({ data: rows });
        for (const row of rows) answer.users.push({ remoteIdentity: row.remoteIdentity, userId: row.id, created: true });
      }
      await this.claimSourceChats(tx, tenantId, sources, answer.users);
      return answer;
    });
  }

  /**
   * A balance file's Telegram column (F-210): each named person — the
   * tenant's, not deleted — gets the claim an import's person would. One
   * transaction; a person not found is left out of the answer.
   */
  async claimTelegram(links: ChatClaim[]): Promise<TelegramLinkAnswer> {
    const tenantId = TenantContext.current('telegram claim').id;
    return tenantTransaction(this.prisma, async (tx) => {
      const live = await tx.user.findMany({ where: { tenantId, id: { in: links.map((l) => l.userId) }, deletedAt: null }, select: { id: true } });
      const ids = new Set(live.map((u) => u.id));
      const claimed = await claimChats(tx, tenantId, SocialPlatform.telegram, links.filter((l) => ids.has(l.userId)));
      return { links: [...claimed].map(([userId, telegram]) => ({ userId, telegram })) };
    });
  }

  /** The chat each source named for its person, claimed (F-210, ADR-0157) and told on the person's answer. */
  private async claimSourceChats(tx: Prisma.TransactionClient, tenantId: string, sources: SourceUser[], users: ImportedUser[]): Promise<void> {
    const chatOf = new Map(sources.map((s) => [s.remoteIdentity, s.telegramId]));
    const claims = users.flatMap((u) => {
      const chatId = chatOf.get(u.remoteIdentity);
      return chatId ? [{ userId: u.userId, chatId }] : [];
    });
    const claimed = await claimChats(tx, tenantId, SocialPlatform.telegram, claims);
    for (const user of users) {
      const outcome = claimed.get(user.userId);
      if (outcome) user.telegram = outcome;
    }
  }

  /**
   * An import's rollback (F-211) removes the people it made: soft-deleted
   * (`deletedAt`), their `remoteIdentity` and username released so a later
   * run of the same source makes them afresh under the same name instead of
   * refusing them `deleted` (rule 4). Only an import's person who did nothing
   * here goes; the rest are kept with why. One already removed is answered
   * removed, so a retried batch is safe. Billing decided they hold nothing
   * there; this is identity's half.
   */
  async removeImported(userIds: string[]): Promise<UserRemovalAnswer> {
    const tenantId = TenantContext.current('user import removal').id;
    const ids = [...new Set(userIds)];
    return tenantTransaction(this.prisma, async (tx) => {
      const users = await tx.user.findMany({
        where: { tenantId, id: { in: ids } },
        select: { id: true, remoteIdentity: true, deletedAt: true, phoneNumber: true, email: true, _count: { select: { sessions: true, linkedBotAccounts: { where: { contactVerifiedAt: { not: null } } } } } },
      });
      const byId = new Map(users.map((u) => [u.id, u]));
      const answer: UserRemovalAnswer = { removed: [], kept: [] };
      const gone: string[] = [];
      for (const id of ids) {
        const user = byId.get(id);
        const reason = !user ? 'not_found' : user.deletedAt ? null : keptBecause(user);
        if (reason) answer.kept.push({ userId: id, reason });
        else if (user?.deletedAt) answer.removed.push(id);
        else gone.push(id);
      }
      if (gone.length > 0) {
        await tx.user.updateMany({ where: { tenantId, id: { in: gone }, deletedAt: null }, data: { deletedAt: new Date(), remoteIdentity: null, username: null } });
        // Their claims go too (F-210): a later run's person, or the chat's real owner, takes the chat afresh.
        await tx.linkedBotAccount.deleteMany({ where: { userId: { in: gone }, contactVerifiedAt: null } });
        answer.removed.push(...gone);
      }
      return answer;
    });
  }

  /** The rows to create, each with a username free in the tenant and in this batch (one read). */
  private async newUsers(
    tx: Prisma.TransactionClient,
    born: { tenantId: string; roleId: string; passwordHash: string },
    sources: SourceUser[],
  ): Promise<Array<Prisma.UserCreateManyInput & { id: string; remoteIdentity: string }>> {
    const bases = sources.map((s) => usernameBase(s.label));
    const clashing = await tx.user.findMany({
      where: { tenantId: born.tenantId, OR: [...new Set(bases)].map((b) => ({ username: { startsWith: b } })) },
      select: { username: true },
    });
    const taken = new Set(clashing.flatMap((u) => (u.username ? [u.username] : [])));
    return sources.map((source, i) => {
      const username = pickUsername(bases[i], taken);
      taken.add(username);
      const fullName = source.label.trim().slice(0, FULL_NAME_MAX) || username;
      return { id: randomUUID(), ...born, username, fullName, status: 'active', remoteIdentity: source.remoteIdentity };
    });
  }
}
