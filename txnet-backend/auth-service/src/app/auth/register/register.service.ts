import { Inject, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { RedisKeys, RedisTtl } from '../../redis/redis.keys';
import { RegisterInput, VerifyPhoneInput } from './register.schema';
import {
  assertPasswordNotContainingProfile,
  PasswordContainsProfileDataError,
} from '../../common/validation/strong-password.schema';
import {
  IOtpService,
  OTP_SERVICE,
  OtpPurpose,
} from '../otp/otp.interface';
import { OtpChannelRegistry } from '../otp/otp-channels.service';
import { BotLinkService } from '../bot-link/bot-link.service';
import { BotPlatform } from '../otp/senders/bot-client.registry';
import { normalizeIranPhone } from '../../common/validation/phone.schema';
import { ok, err, safeExecute } from '../../common/response/response.util';

/**
 * Registration data held in Redis between `register` and a successful
 * `verify-phone` — the `user` row is created only once this is consumed, see
 * identity/invariants.md #11.
 */
type PendingRegistration = {
  fullName: string;
  username: string;
  phoneNumber: string;
  passwordHash: string;
  tenantId: string;
  roleId: string;
};

@Injectable()
export class RegisterService {
  private readonly logger = new Logger(RegisterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Inject(OTP_SERVICE) private readonly otpService: IOtpService,
    private readonly channels: OtpChannelRegistry,
    private readonly botLinks: BotLinkService,
  ) {}

  async register(input: RegisterInput, requestIp: string, lang: string) {
    return safeExecute(async () => {
      // 1. Password strength against profile data
      try {
        assertPasswordNotContainingProfile(input.password, {
          username: input.username,
          fullName: input.fullName,
          phoneNumber: input.phoneNumber,
        });
      } catch (e) {
        if (e instanceof PasswordContainsProfileDataError) {
          return err('password.containsProfileData');
        }
        throw e; // rethrow unexpected
      }

      // 2. Get default tenant and role
      const tenant = await this.prisma.tenant.findFirst({
        where: { slug: 'platform_owner' },
      });
      const role = await this.prisma.role.findFirst({
        where: { name: 'user' },
      });
      if (!tenant || !role) {
        return err('register.defaultRoleMissing');
      }

      // 3. Normalize phone number
      const phoneNumber = normalizeIranPhone(input.phoneNumber);

      // 4. Reject a username/phone already claimed by a real account. This
      // is a best-effort check — the Postgres unique constraint on `user`
      // is the authoritative guard, re-checked when verify-phone promotes
      // the pending record (below).
      const existing = await this.prisma.user.findFirst({
        where: { OR: [{ username: input.username }, { phoneNumber }] },
        select: { id: true },
      });
      if (existing) {
        return err('register.duplicateUser');
      }

      // 5. Hash password
      const passwordHash = await argon2.hash(input.password, {
        type: argon2.argon2id,
      });

      // 6. Stash the registration — no `user` row exists until the phone is
      // verified (identity/invariants.md #11). A re-submit for the same
      // phone overwrites the pending record, matching the "one active OTP
      // per phone" invariant (#10): whichever OTP is still valid is the one
      // that can complete registration.
      const pending: PendingRegistration = {
        fullName: input.fullName,
        username: input.username,
        phoneNumber,
        passwordHash,
        tenantId: tenant.id,
        roleId: role.id,
      };
      await this.redis.setJson(
        RedisKeys.registerPending(phoneNumber),
        pending,
        RedisTtl.registerPending,
      );

      // 7. Send OTP on a channel this environment actually offers. SMS is no
      // longer assumed: an operator running messengers-only must still be able
      // to register people.
      const channel = input.channel ?? this.channels.defaultChannel();
      if (!channel) return err('otp.noChannelAvailable');

      if (this.channels.requiresLink(channel)) {
        this.channels.assertUsable(channel);
        const platform = channel as unknown as BotPlatform;
        if (!(await this.botLinks.hasVerifiedLink(phoneNumber, platform))) {
          // No code yet: the bot sends it once this person proves the number
          // is theirs. `verify-phone` turns that proof into a linked account.
          const started = await this.botLinks.startLink({
            platform,
            phoneNumber,
            purpose: OtpPurpose.register_phone_verify,
            lang,
            ip: requestIp,
          });
          return ok(
            { phoneNumber, requiresPhoneVerification: true, ...started },
            'auth.botLinkRequired',
          );
        }
      }

      await this.otpService.issueOtp(
        phoneNumber,
        OtpPurpose.register_phone_verify,
        channel,
        requestIp,
        lang,
      );

      // 8. Success
      return ok({ phoneNumber, requiresPhoneVerification: true }, 'register.success');
    });
  }

  async verifyPhone(input: VerifyPhoneInput) {
    return safeExecute(async () => {
      const phoneNumber = normalizeIranPhone(input.phoneNumber);

      const isValid = await this.otpService.verifyOtp(
        phoneNumber,
        OtpPurpose.register_phone_verify,
        input.otpCode,
      );
      if (!isValid) {
        return err('otp.invalid');
      }

      const pending = await this.redis.getJson<PendingRegistration>(
        RedisKeys.registerPending(phoneNumber),
      );
      if (!pending) {
        return err('register.pending.expired');
      }

      // Create user with unique constraint handling
      try {
        const user = await this.prisma.user.create({
          data: {
            fullName: pending.fullName,
            username: pending.username,
            phoneNumber: pending.phoneNumber,
            passwordHash: pending.passwordHash,
            tenantId: pending.tenantId,
            roleId: pending.roleId,
            status: 'active',
            phoneVerifiedAt: new Date(),
          },
          select: { id: true },
        });

        await this.redis.del(RedisKeys.registerPending(phoneNumber));

        // If this registration was verified over a bot, the chat that proved
        // the number is only a Redis entry until now — there was no user row
        // to attach it to. There is one now.
        await this.botLinks.promoteProvenChat(user.id, phoneNumber);

        return ok(
          { userId: user.id, phoneVerified: true },
          'register.phoneVerified',
        );
      } catch (e: any) {
        if (e?.code === 'P2002') {
          const target = e?.meta?.target ?? [];
          this.logger.log(
            `duplicate registration attempt at verify, target=${target.join(',')}`,
          );
          return err('register.duplicateUser'); // 'target' (db columns) is logged above, not returned
        }
        throw e; // unexpected error
      }
    });
  }
}
