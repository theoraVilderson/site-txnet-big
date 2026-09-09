import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { IOtpSender } from './otp-sender.interface';
import { OtpChannel, OtpPurpose } from '../otp.interface';
import { BotClientRegistry } from '@txnet-backend/messenger';
import { TenantContext } from '../../../tenant-context/tenant-context';
import { BotLinkStore } from '../../bot-link/bot-link.store';
import { buildOtpChatMessage } from './otp-message.util';
import { LocaleService } from '../../../locale/locale.service';

@Injectable()
export class BaleOtpSender implements IOtpSender {
  readonly channel = OtpChannel.bale;
  readonly requiresLinkedAccount = true;
  private readonly logger = new Logger(BaleOtpSender.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly bots: BotClientRegistry,
    private readonly links: BotLinkStore,
    private readonly localeService: LocaleService,
  ) {}

  /**
   * The tenant in scope has a usable bale bot.
   *
   * Per tenant, not per deployment: the token lives on that tenant's own
   * `BotIntegration` now (F-066-i). A request with no tenant resolved never
   * reaches here — `TenantGuard` refuses it first — so asking for the current
   * one is safe.
   */
  async isConfigured(): Promise<boolean> {
    const tenantId = TenantContext.currentOrNull()?.id;
    if (!tenantId) return false;
    return this.bots.canSend(tenantId, 'bale');
  }

  async send(
    phoneNumber: string,
    code: string,
    purpose: OtpPurpose,
    lang: string,
  ): Promise<void> {
    const tenantId = TenantContext.current('bale OTP delivery').id;
    const client = await this.bots.primaryClient(
      tenantId,
      'bale',
      'identity:BaleOtpSender',
    );
    if (!client) {
      this.logger.error(
        `tenant ${tenantId} has no usable bale bot — OTP not sent`,
      );
      throw new BadRequestException('otp.baleNotConfigured');
    }

    const chatId = await this.resolveChatId(phoneNumber);
    if (!chatId) throw new BadRequestException('otp.baleNotLinked');

    const ns = this.localeService.getNamespace(lang, 'notifications');
    const text = buildOtpChatMessage(ns, code, purpose);
    await client.sendMessage(chatId, text);
  }

  /**
   * Which chat this phone's code goes to.
   *
   * Normally the user's `linked_bot_account`, and only one whose
   * `contactVerifiedAt` is set — an unproven chat id was never shown to belong
   * to this number (identity/invariants.md #12). During registration there is
   * deliberately no `user` row yet, so a chat that has already passed the
   * contact check is held in Redis and used from there until `verify-phone`
   * promotes it.
   */
  private async resolveChatId(phoneNumber: string): Promise<string | null> {
    const user = await this.prisma.user.findFirst({
      where: { phoneNumber },
      select: { id: true },
    });

    if (user) {
      const link = await this.prisma.linkedBotAccount.findFirst({
        where: {
          userId: user.id,
          platform: 'bale',
          contactVerifiedAt: { not: null },
        },
        select: { platformUserId: true },
      });
      if (link) return link.platformUserId;
    }

    return this.links.provenChat('bale', phoneNumber);
  }
}
