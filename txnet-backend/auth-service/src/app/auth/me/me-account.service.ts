import { BadRequestException, Injectable } from '@nestjs/common';
import { BackendI18nKeys, err, ok } from '@txnet-backend/shared-core';
import * as argon2 from 'argon2';
import { PrismaService } from '../../prisma/prisma.service';
import {
  assertPasswordNotContainingProfile,
  PasswordContainsProfileDataError,
} from '../../common/validation/strong-password.schema';
import { ActiveSessionsService } from '../session/active-sessions.service';
import type { AuthClaims } from '../token.service';

export type PasswordChange = { currentPassword: string; newPassword: string; endOtherSessions: boolean };

/**
 * The signed-in user's own name and password (UX-1-t, panel-web/contract.ux.md
 * S3–S4). Only the caller's own row.
 *
 * A change is not a reset: the caller proves the current password (never null
 * — every account is created with one), and this place stays signed in. The
 * other places end only when asked, and then through SES-1-a's
 * `terminateOthers`, so "sign out every other place" here means exactly what
 * it means on the session list — switch groups and bot links included.
 */
@Injectable()
export class MeAccountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: ActiveSessionsService,
  ) {}

  async rename(claims: AuthClaims, fullName: string) {
    const user = await this.prisma.user.update({ where: { id: claims.sub }, data: { fullName }, select: { fullName: true } });
    return ok({ fullName: user.fullName }, 'auth.nameSaved');
  }

  async changePassword(claims: AuthClaims, input: PasswordChange) {
    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      select: { passwordHash: true, username: true, fullName: true, phoneNumber: true },
    });
    if (!user || !(await argon2.verify(user.passwordHash, input.currentPassword))) {
      // 400 with a reason, not a 401: the session is fine, the form is wrong.
      throw new BadRequestException({ i18nKey: BackendI18nKeys.errors.auth.wrongPassword, reason: 'wrong_password' });
    }

    try {
      assertPasswordNotContainingProfile(input.newPassword, user);
    } catch (e) {
      if (e instanceof PasswordContainsProfileDataError) return err('password.containsProfileData');
      throw e;
    }

    const passwordHash = await argon2.hash(input.newPassword, { type: argon2.argon2id });
    await this.prisma.user.update({ where: { id: claims.sub }, data: { passwordHash }, select: { id: true } });

    let otherSessionsEnded = 0;
    if (input.endOtherSessions) {
      const ended = await this.sessions.terminateOthers(claims);
      // `safeExecute` passes the inner envelope through, so `data` is `{terminated}`; its type says otherwise.
      if (ended.ok) otherSessionsEnded = (ended.data as unknown as { terminated: number }).terminated;
    }
    return ok({ otherSessionsEnded }, 'auth.passwordChanged');
  }
}
