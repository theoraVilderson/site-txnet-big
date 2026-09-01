import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../../prisma/prisma.service';
import { RegisterInput, VerifyPhoneInput } from './register.schema';
import {
  assertPasswordNotContainingProfile,
  PasswordContainsProfileDataError,
} from '../../common/validation/strong-password.schema';
import {
  IOtpService,
  OTP_SERVICE,
  OtpChannel,
  OtpPurpose,
} from '../otp/otp.interface';
import { normalizeIranPhone } from '../../common/validation/phone.schema';
import { ok, err, safeExecute } from '../../common/response/response.util';

@Injectable()
export class RegisterService {
  private readonly logger = new Logger(RegisterService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OTP_SERVICE) private readonly otpService: IOtpService,
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

      // 2. Hash password
      const passwordHash = await argon2.hash(input.password, {
        type: argon2.argon2id,
      });

      // 3. Get default tenant and role
      const tenant = await this.prisma.tenant.findFirst({
        where: { slug: 'platform_owner' },
      });
      const role = await this.prisma.role.findFirst({
        where: { name: 'user' },
      });
      if (!tenant || !role) {
        return err('register.defaultRoleMissing');
      }

      // 4. Normalize phone number
      const phoneNumber = normalizeIranPhone(input.phoneNumber);

      // 5. Create user with unique constraint handling
      try {
        const user = await this.prisma.user.create({
          data: {
            fullName: input.fullName,
            username: input.username,
            phoneNumber,
            passwordHash,
            tenantId: tenant.id,
            roleId: role.id,
            status: 'active',
          },
          select: { id: true },
        });

        // 6. Send OTP
        await this.otpService.issueOtp(
          phoneNumber,
          OtpPurpose.register_phone_verify,
          OtpChannel.sms,
          requestIp,
          lang,
        );

        // 7. Success
        return ok(
          { userId: user.id, requiresPhoneVerification: true },
          'register.success',
        );
      } catch (e: any) {
        if (e?.code === 'P2002') {
          const target = e?.meta?.target ?? [];
          this.logger.log(
            `duplicate registration attempt, target=${target.join(',')}`,
          );
          return err('register.duplicateUser'); // 'target' (db columns) is logged above, not returned
        }
        throw e; // unexpected error
      }
    });
  }

  async verifyPhone(input: VerifyPhoneInput) {
    return safeExecute(async () => {
      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: input.userId },
      });

      const isValid = await this.otpService.verifyOtp(
        user.phoneNumber!,
        OtpPurpose.register_phone_verify,
        input.otpCode,
      );
      if (!isValid) {
        return err('otp.invalid');
      }

      await this.prisma.user.update({
        where: { id: input.userId },
        data: { phoneVerifiedAt: new Date() },
      });

      return ok(
        { userId: input.userId, phoneVerified: true },
        'register.phoneVerified',
      );
    });
  }
}
