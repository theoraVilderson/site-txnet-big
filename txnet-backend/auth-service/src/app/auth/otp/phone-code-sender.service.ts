import { Inject, Injectable } from '@nestjs/common';
import { OtpChannel } from '@prisma/client';
import { isBotPlatform } from '@txnet-backend/messenger';
import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { ok, err } from '../../common/response/response.util';
import { BotLinkService } from '../bot-link/bot-link.service';
import { deliveryHandles } from './otp-answer';
import { OtpChannelRegistry } from './otp-channels.service';
import { OtpDeliveryStore } from './otp-delivery.store';
import { IOtpService, OTP_SERVICE, OtpPurpose } from './otp.interface';

/**
 * The code (or the bot link) that proves a number no account holds yet —
 * registration's, and the platform owner's first sign-in (F-0102). SMS is not
 * assumed: an operator running messengers only must still reach the person.
 */
@Injectable()
export class PhoneCodeSender {
  constructor(
    @Inject(OTP_SERVICE) private readonly otp: IOtpService,
    private readonly channels: OtpChannelRegistry,
    private readonly botLinks: BotLinkService,
    private readonly deliveries: OtpDeliveryStore,
  ) {}

  /** Sends to `phoneNumber` by the chosen channel (else the first available); `sentKey` is the answer's message once a code is on its way. */
  async send(
    phoneNumber: string,
    purpose: OtpPurpose,
    options: { chosen?: OtpChannel; ip: string; lang: string; sentKey: string },
  ) {
    const channel = options.chosen ?? (await this.channels.defaultChannel());
    if (!channel) return err(BackendI18nKeys.errors.otp.noChannelAvailable);

    if (this.channels.requiresLink(channel) && isBotPlatform(channel)) {
      await this.channels.assertUsable(channel);
      if (!(await this.botLinks.hasVerifiedLink(phoneNumber, channel))) {
        // No code yet: the bot sends it once this person proves the number
        // is theirs, and the verify step turns that proof into a linked account.
        const started = await this.botLinks.startLink({ platform: channel, phoneNumber, purpose, lang: options.lang, ip: options.ip });
        return ok({ phoneNumber, requiresPhoneVerification: true, ...started }, BackendI18nKeys.errors.auth.botLinkRequired);
      }
    }

    const delivery = await this.deliveries.mintHandles();
    await this.otp.issueOtp(phoneNumber, purpose, channel, options.ip, options.lang, delivery);
    return ok({ phoneNumber, requiresPhoneVerification: true, ...deliveryHandles(delivery) }, options.sentKey);
  }
}
