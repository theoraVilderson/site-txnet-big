import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { ServiceOnlyGuard } from '../../common/guards/service-only.guard';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe';
import {
  IOtpService,
  OTP_SERVICE,
  OtpChannel,
  OtpDeliveryRequest,
  OtpDeliveryResult,
  OtpPurpose,
} from './otp.interface';

export const otpDeliverSchema = z.object({
  tenantId: z.string().min(1),
  phoneNumber: z.string().min(1),
  purpose: z.nativeEnum(OtpPurpose),
  channel: z.nativeEnum(OtpChannel),
  requestIp: z.string().default(''),
  lang: z.string().min(1),
  deliveryId: z.string().min(1),
  // The realtime channel the result is published to (F-067-j). Carried on the
  // message because the publishing process did not mint it.
  channelId: z.string().min(1),
});

/**
 * The seam a worker sends an OTP through (F-067-a).
 *
 * **Why the send comes back into this process at all.** The senders are
 * identity's, they are tenant-scoped, and they need `BotLinkStore`,
 * `TenantContext`, `LocaleService` and the messenger client registry — about
 * 1300 lines that would have to cross an Nx application boundary into a
 * workspace library to serve one caller. `worker-service` already answered
 * exactly this question for the Credential Vault and answered it this way
 * (`vault-retention.job.ts`, F-031-c): reach the owning service over the
 * internal seam rather than move its code. Answering it the other way for the
 * second caller would leave two rules in one worker.
 *
 * What the feature actually removes is the provider round trip from the
 * **user's** request and from the Redis lock that request holds — not from
 * this process's event loop, which was never the expensive part of an awaited
 * HTTP call.
 *
 * The tenant comes from `X-Tenant-Id`, honoured because the service token
 * verified (`TenantMiddleware.botClaim`); `tenantId` in the body is the same
 * value and is what the message carried. Nothing here trusts the body for
 * scope — the ambient context is what every key and query derives from
 * (ADR-0024).
 *
 * Guarded by `ServiceOnlyGuard`, so an unrecognised caller gets a 404 that is
 * indistinguishable from a route that does not exist.
 */
@Controller('internal/otp')
@UseGuards(ServiceOnlyGuard)
export class OtpInternalController {
  constructor(@Inject(OTP_SERVICE) private readonly otp: IOtpService) {}

  /**
   * Draw and send one code.
   *
   * A 200 with `delivered:false` is a refusal the user has been told about
   * through the delivery status; the caller acks it. Anything this throws is
   * a 5xx, and the caller lets the message dead-letter (F-067-d).
   */
  @Post('deliver')
  async deliver(
    @Body(new ZodValidationPipe(otpDeliverSchema))
    body: OtpDeliveryRequest,
  ): Promise<OtpDeliveryResult> {
    return this.otp.deliverOtp(body);
  }
}
