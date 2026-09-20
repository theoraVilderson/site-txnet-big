import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma, TenantType, UserStatus } from '@prisma/client';
import { BackendI18nKeys, ok } from '@txnet-backend/shared-core';
import { PrismaService } from '../../prisma/prisma.service';
import { maskPhone, parsePhone } from '../../common/validation/phone.schema';
import type { UserSearchInput } from '../auth.schema';
import type { AuthClaims } from '../token.service';

/** The permission `GET /auth/users` needs (F-018-ad). No role is granted it; SuperAdmin holds it as `*`. */
export const USER_SEARCH = 'user.search';

/**
 * One row of the picker. Enough to tell two people apart and to see that one
 * is suspended before naming them; never the number, never an email.
 */
export type UserSearchHit = {
  id: string;
  fullName: string;
  username: string | null;
  phoneMasked: string | null;
  status: UserStatus;
};

/** The shortest digit run that is matched as part of a number rather than ignored. */
const MIN_PHONE_DIGITS = 4;

/**
 * The platform owner finds a user by phone, username or email (F-018-ad) — the
 * reseller create sheet's owner picker (F-018-ae), and later staff (F-018-j).
 *
 * The read runs in the caller's own tenant (RLS), which for the only admitted
 * caller is the platform's: exactly the users F-018-k accepts as an owner.
 */
@Injectable()
export class UserSearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(claims: AuthClaims, input: UserSearchInput) {
    // The permission is not the boundary: a reseller administers its own roles
    // and could grant itself the key (audit invariant #9, as `me` explains).
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: claims.tenantId },
      select: { tenantType: true },
    });
    if (tenant?.tenantType !== TenantType.platform_owner) {
      throw new ForbiddenException(BackendI18nKeys.errors.auth.userSearchRefused);
    }

    const rows = await this.prisma.user.findMany({
      where: { deletedAt: null, OR: matchers(input.q) },
      select: { id: true, fullName: true, username: true, phoneNumber: true, status: true },
      orderBy: { createdAt: 'desc' },
      take: input.limit,
    });

    const users: UserSearchHit[] = rows.map((row) => ({
      id: row.id,
      fullName: row.fullName,
      username: row.username,
      phoneMasked: maskPhone(row.phoneNumber),
      status: row.status,
    }));
    return ok({ users }, BackendI18nKeys.errors.auth.userSearch);
  }
}

/**
 * A whole number in any spelling matches its stored E.164 form exactly; a
 * partial one matches on its digits with the trunk zero dropped, so `0912`
 * finds `+98912…`. Username and email match as substrings.
 *
 * Exported for `reseller-users.service.ts` (F-311-a): a reseller searching its
 * own users is the same question asked inside a different scope, and two
 * spellings of "what counts as a match" would drift apart the first time one
 * of them learned about a new column.
 */
export function matchers(q: string): Prisma.UserWhereInput[] {
  const or: Prisma.UserWhereInput[] = [
    { username: { contains: q, mode: 'insensitive' } },
    { email: { contains: q, mode: 'insensitive' } },
  ];
  const e164 = parsePhone(q);
  if (e164) {
    or.push({ phoneNumber: e164 });
  } else if (/^[+\d\s-]+$/.test(q)) {
    const digits = q.replace(/\D/g, '').replace(/^0+/, '');
    if (digits.length >= MIN_PHONE_DIGITS) or.push({ phoneNumber: { contains: digits } });
  }
  return or;
}
