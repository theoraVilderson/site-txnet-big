import { Inject, Injectable, Logger } from '@nestjs/common';
import { err, ok, safeExecute } from '@txnet-backend/shared-core';
import { PrismaService } from '../../prisma/prisma.service';
import { deliveryHandles } from '../auth.service';
import { OtpDeliveryStore } from '../otp/otp-delivery.store';
import {
  IOtpService,
  OTP_SERVICE,
  OtpChannel,
  OtpPurpose,
} from '../otp/otp.interface';
import type { AuthClaims } from '../token.service';

/** One spelling per address, before it keys a code or reaches a column. */
export function normalizeEmail(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * The caller's own email address (F-035-g, D-39): ask for a code mailed to an
 * address, then confirm it.
 *
 * **`user.email` is written in one place — `confirm`, after the code
 * verified** — so a non-null address is one somebody proved they read, and a
 * sender (F-035-h) needs no second check. Nothing is stored between the two
 * steps except the code's hash, keyed by the address: the confirm call names
 * the address again, and only whoever read the mail can pair it with the code.
 *
 * Asking reads no other account. Whether an address is already taken within
 * the tenant (`@@unique([tenantId, email])`) is answered by the write in
 * `confirm` — to the inbox's owner — and never by the request, which any
 * signed-in user could otherwise loop over a list of addresses.
 */
@Injectable()
export class MeEmailService {
  private readonly logger = new Logger(MeEmailService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(OTP_SERVICE) private readonly otp: IOtpService,
    private readonly deliveries: OtpDeliveryStore,
  ) {}

  async requestCode(claims: AuthClaims, rawAddress: string, ip: string, lang: string) {
    return safeExecute(async () => {
      const address = normalizeEmail(rawAddress);
      const user = await this.prisma.user.findUnique({
        where: { id: claims.sub },
        select: { email: true },
      });
      if (user?.email === address) {
        return err('auth.emailAlreadyVerified');
      }

      // The same 202 as every other code (F-067-a): accepted for delivery, not
      // delivered; the handles are how the panel learns which.
      const delivery = await this.deliveries.mintHandles();
      await this.otp.issueOtp(
        address,
        OtpPurpose.email_verify,
        OtpChannel.email,
        ip,
        lang,
        delivery,
      );
      return ok({ accepted: true, ...deliveryHandles(delivery) }, 'auth.emailCodeSent');
    });
  }

  async confirm(claims: AuthClaims, rawAddress: string, code: string) {
    return safeExecute(async () => {
      const address = normalizeEmail(rawAddress);
      // Throws on a wrong, expired or exhausted code — nothing below runs.
      await this.otp.verifyOtp(address, OtpPurpose.email_verify, code);

      try {
        const user = await this.prisma.user.update({
          where: { id: claims.sub },
          data: { email: address, emailVerifiedAt: new Date() },
          select: { email: true, emailVerifiedAt: true },
        });
        return ok(user, 'auth.emailVerified');
      } catch (e: any) {
        if (e?.code === 'P2002') {
          this.logger.log(`email already held in tenant, user=${claims.sub}`);
          return err('auth.emailTaken');
        }
        throw e;
      }
    });
  }
}
