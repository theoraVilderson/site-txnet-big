import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { BotClientRegistry, isBotPlatform } from '@txnet-backend/messenger';
import { ServiceOnlyGuard } from '../common/service-only.guard';
import { BotCopy } from '../locale/bot-copy';
import { BotKeys } from '../locale/bot-keys';
import { money } from '../locale/money';

const invoiceLinkSchema = z.object({
  tenantId: z.string().min(1),
  platform: z.string().refine(isBotPlatform, 'unknown platform'),
  paymentId: z.string().min(1),
  currency: z.string().min(1),
  amountMinor: z.string().regex(/^[1-9]\d*$/),
  providerToken: z.string().min(1).nullable(),
  credited: z.string().min(1),
  /** What `credited` is in (F-116-h4); optional so an older billing's request still links. */
  currencyCode: z.string().regex(/^[A-Z]{3}$/).optional(),
  lang: z.string().min(1),
});

/**
 * A Mini App's invoice link (F-104-q). `billing` holds no bot token, so when a
 * top-up at an in-chat gateway is started from the Mini App, `start` asks here
 * and answers the panel the link its SDK's `openInvoice` takes.
 *
 * The invoice is the one the chat sends (F-104-m, `BotDispatcher`): same text,
 * payload = the payment id, so `pre_checkout_query` and `successful_payment`
 * reach `InChatPayment` and billing exactly as they do from the chat. It is made
 * by the tenant's **primary** bot on that messenger — the payment's events
 * arrive at whichever bot made the link.
 *
 * Service-only, like `dispatch`: the caller is trusted to name the tenant.
 * Nothing about the body is logged; it carries the provider token.
 */
@Controller('internal/bots')
@UseGuards(ServiceOnlyGuard)
export class InvoiceLinkController {
  private readonly logger = new Logger(InvoiceLinkController.name);

  constructor(
    private readonly bots: BotClientRegistry,
    private readonly copy: BotCopy,
  ) {}

  @Post('invoice-link')
  @HttpCode(HttpStatus.OK)
  async create(@Body() raw: unknown): Promise<{ link: string }> {
    const parsed = invoiceLinkSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException('not an invoice link request');
    }
    const body = parsed.data;
    const platform = body.platform;
    if (!isBotPlatform(platform)) throw new BadRequestException('not an invoice link request');

    const client = await this.bots.primaryClient(body.tenantId, platform, 'bot-app:InvoiceLink');
    if (!client) {
      this.logger.warn(`${platform}: tenant ${body.tenantId} has no usable bot for payment ${body.paymentId}`);
      throw new UnprocessableEntityException('no bot');
    }

    const t = (key: string, values?: Record<string, string>) => this.copy.text(body.lang, { key, ...(values ? { values } : {}) });
    const made = await client.createInvoiceLink({
      title: t(BotKeys.topUp.invoiceTitle),
      description: this.copy.text(body.lang, { key: BotKeys.topUp.invoiceDescription, values: { credited: money(body.credited, body.currencyCode) } }),
      payload: body.paymentId,
      currency: body.currency,
      prices: [{ label: t(BotKeys.topUp.invoiceLabel), amount: Number(body.amountMinor) }],
      // Whether a platform needs one is messenger's call (F-104-l), not this one's.
      ...(body.providerToken ? { providerToken: body.providerToken } : {}),
    });
    if (!made.ok) {
      this.logger.error(`${platform}: invoice link for payment ${body.paymentId} not made: ${'reason' in made ? made.reason : ''}`);
      throw new BadGatewayException('no link');
    }
    return { link: made.link };
  }
}
