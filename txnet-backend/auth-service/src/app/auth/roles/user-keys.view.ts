import type { Prisma } from '@prisma/client';

import type { AccessReader } from '../permissions/access.reader';
import { permissionsOf } from '../users/authority';

/** A key given or taken: which, why, by whom, since when (AC-1-l), and for which window (F-030-a; null ends: none). */
export type KeyOverride = { key: string; reason: string; by: string; at: string; startsAt: string | null; endsAt: string | null };

/** A person's keys by where each comes from (AC-1-l), and the answer they add up to (ADR-0138). */
export type PersonKeys = {
  userId: string;
  keys: string[];
  role: { id: string; name: string; keys: string[] };
  /** Each group that gives them access, and every key it gives (AC-1-n). */
  groups: { id: string; name: string; keys: string[] }[];
  given: KeyOverride[];
  taken: KeyOverride[];
};

export type KeyEffect = 'give' | 'take';

/** A give's or a take's input on the wire (AC-1-l), with F-030-a's optional window. */
export type KeyWrite = { effect: KeyEffect; reason: string; startsAt?: Date | null; endsAt?: Date | null };

/** The window a write asks for, refused before anything is read (F-030-a). */
export type KeyWindowRejection = 'window_on_take' | 'window_past' | 'window_inverted';

/** A person as a key write reads them: their role and its keys, inside the tenant's scope. */
export const PERSON = { id: true, tenantId: true, roleId: true, role: { select: { name: true, rolePermissions: { select: { permission: { select: { key: true } } } } } } } as const;
export type KeyPerson = Prisma.UserGetPayload<{ select: typeof PERSON }>;

/**
 * Why a write's window means nothing, or null (F-030-a): only a give holds
 * for a window — a take is lifted by hand — and its end lies ahead of now and
 * of its start.
 */
export function keyWindowRefusal(input: KeyWrite, now: Date): KeyWindowRejection | null {
  if (!input.startsAt && !input.endsAt) return null;
  if (input.effect === 'take') return 'window_on_take';
  if (input.endsAt && input.endsAt <= now) return 'window_past';
  if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt) return 'window_inverted';
  return null;
}

/** The window as stored: a start not in the future is no start — the key counts at once, and its giver's write tells (F-030-a). */
export function storedWindow(input: KeyWrite, now: Date): { startsAt: Date | null; endsAt: Date | null } {
  return { startsAt: input.startsAt && input.startsAt > now ? input.startsAt : null, endsAt: input.endsAt ?? null };
}

/** One person's keys by source — what the Permissions section shows (AC-1-n). */
export async function personKeysOf(answers: AccessReader, tx: Prisma.TransactionClient, person: KeyPerson): Promise<PersonKeys> {
  const [answer, groups, rows] = await Promise.all([
    answers.ofLoaded(person, tx),
    answers.groupsOf(person.id, tx),
    tx.userPermission.findMany({
      where: { userId: person.id },
      select: { effect: true, reason: true, grantedByUserId: true, updatedAt: true, startsAt: true, endsAt: true, permission: { select: { key: true } } },
    }),
  ]);
  const of = (effect: KeyEffect): KeyOverride[] =>
    rows
      .filter((r) => r.effect === effect)
      .map((r) => ({
        key: r.permission.key,
        reason: r.reason,
        by: r.grantedByUserId,
        at: r.updatedAt.toISOString(),
        startsAt: r.startsAt?.toISOString() ?? null,
        endsAt: r.endsAt?.toISOString() ?? null,
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
  return {
    userId: person.id,
    keys: answer.keys,
    role: { id: person.roleId, name: person.role?.name ?? '', keys: permissionsOf(person) },
    groups,
    given: of('give'),
    taken: of('take'),
  };
}
