import { Inject, Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { PrismaService } from '../../prisma/prisma.service';
import { ok, err, safeExecute } from '../../common/response/response.util';
import {
  assertPasswordNotContainingProfile,
  PasswordContainsProfileDataError,
} from '../../common/validation/strong-password.schema';
import { AuthService } from '../auth.service';
import { BotLinkService } from '../bot-link/bot-link.service';
import { IOtpService, OTP_SERVICE, OtpPurpose } from '../otp/otp.interface';
import { PhoneCodeSender } from '../otp/phone-code-sender.service';
import { OWNER_SETUP_PURPOSE, TokenService } from '../token.service';
import type { OwnerSetupCodeInput, OwnerSetupInput } from './owner-setup.schema';

const KEYS = BackendI18nKeys.errors.auth;

/**
 * The code that proves the owner's number is the one registration uses: both
 * prove a number that becomes an account's only after the code (F-0102).
 */
const PHONE_PROOF = OtpPurpose.register_phone_verify;

/** Where the session that ends the setup is opened from. */
export type SetupRequestContext = { ip: string; userAgent: string; scopeKey?: string | null };

/**
 * The fresh install's first sign-in (F-0102, identity contract.owner-setup.md):
 * the owner proves a number of their own, then keeps the account under their
 * own username and password. The setup token is the whole proof of the first
 * password; it has no session id, so nothing else admits it.
 */
@Injectable()
export class OwnerSetupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly codes: PhoneCodeSender,
    @Inject(OTP_SERVICE) private readonly otp: IOtpService,
    private readonly botLinks: BotLinkService,
    private readonly auth: AuthService,
  ) {}

  /** Sends the code to the number the owner will keep, unless another account holds it. */
  async sendCode(input: OwnerSetupCodeInput, ip: string, lang: string) {
    return safeExecute(async () => {
      const owner = await this.ownerOf(input.setupToken);
      if (!owner) return err(KEYS.invalidSetupToken);
      if (await this.heldByAnother(input.phoneNumber, owner.id)) return err(KEYS.ownerSetupPhoneTaken);
      return this.codes.send(input.phoneNumber, PHONE_PROOF, { chosen: input.channel, ip, lang, sentKey: KEYS.ownerSetupCodeSent });
    });
  }

  /** Checks the code, writes the owner's own account once, and opens its first session. */
  async complete(input: OwnerSetupInput, request: SetupRequestContext) {
    return safeExecute(async () => {
      const owner = await this.ownerOf(input.setupToken);
      if (!owner) return err(KEYS.invalidSetupToken);
      // 2.2, before a code is spent on a password that would be refused.
      const refused = passwordRefusal(input, owner.fullName);
      if (refused) return refused;
      if (!(await this.otp.verifyOtp(input.phoneNumber, PHONE_PROOF, input.otpCode))) return err(BackendI18nKeys.errors.otp.invalid);

      const written = await this.write(owner.id, input);
      if (written !== 'written') return err(written === 'taken' ? KEYS.ownerSetupTaken : KEYS.invalidSetupToken);
      // A number proved over a bot is only a Redis entry until an account holds it.
      await this.botLinks.promoteProvenChat(owner.id, input.phoneNumber);

      const user = await this.auth.findUserForSession(owner.id);
      if (!user) return err(KEYS.invalidSetupToken);
      // Both factors are proved: the first password (the token) and the code.
      const session = await this.auth.createSessionForUser(user, request.ip, request.userAgent, request.scopeKey, null, true);
      return ok(session, KEYS.ownerSetupDone);
    });
  }

  /** The account the token names, while its setup is still open. */
  private async ownerOf(setupToken: string) {
    const claims = this.tokens.verify(setupToken);
    if (!claims?.sub || claims.purpose !== OWNER_SETUP_PURPOSE) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
      select: { id: true, fullName: true, setupRequired: true, deletedAt: true },
    });
    return user && user.setupRequired && !user.deletedAt ? user : null;
  }

  private async heldByAnother(phoneNumber: string, ownerId: string) {
    return !!(await this.prisma.user.findFirst({ where: { phoneNumber, NOT: { id: ownerId } }, select: { id: true } }));
  }

  /** One conditional write: a second completion, or a race, finds `setupRequired` already false. */
  private async write(ownerId: string, input: OwnerSetupInput): Promise<'written' | 'closed' | 'taken'> {
    const passwordHash = await argon2.hash(input.newPassword, { type: argon2.argon2id });
    try {
      const { count } = await this.prisma.user.updateMany({
        where: { id: ownerId, setupRequired: true },
        data: { username: input.username, passwordHash, phoneNumber: input.phoneNumber, phoneVerifiedAt: new Date(), setupRequired: false },
      });
      return count === 1 ? 'written' : 'closed';
    } catch (e) {
      if (e instanceof Error && 'code' in e && e.code === 'P2002') return 'taken';
      throw e;
    }
  }
}

/** The 2.2 profile rule over what the owner is about to keep; `null` when the password passes. */
function passwordRefusal(input: OwnerSetupInput, fullName: string) {
  try {
    assertPasswordNotContainingProfile(input.newPassword, { username: input.username, fullName, phoneNumber: input.phoneNumber });
    return null;
  } catch (e) {
    if (e instanceof PasswordContainsProfileDataError) return err(BackendI18nKeys.errors.password.containsProfileData);
    throw e;
  }
}
