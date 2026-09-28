import { Injectable, Logger } from '@nestjs/common';
import { BotText, PaymentEvent, TelegramLikeBotClient } from '@txnet-backend/messenger';
import { BillingApiClient, InChatPaymentBody, PreCheckoutVerdict } from '../billing-api/billing-api.client';
import { ChatContext } from '../conversation/nav.types';
import { BotCopy } from '../locale/bot-copy';
import { BotKeys } from '../locale/bot-keys';
import { money } from '../locale/money';

type Refusal = Extract<PreCheckoutVerdict, { approved: false }>['reason'];

/** Every refusal billing can give has a sentence; a new one does not compile until it gets one. */
const REFUSAL_KEY: Record<Refusal, string> = {
  not_found: BotKeys.topUp.refusedNotFound,
  not_payable: BotKeys.topUp.refusedNotPayable,
  amount_mismatch: BotKeys.topUp.refusedAmount,
};

/**
 * The bot's half of an in-chat payment (F-104-m, D-32): the two events the
 * messenger reports (F-104-l), relayed to billing (F-104-k) with the sender the
 * platform named and this bot's tenant. **No chat session is read (F-104-ab):**
 * the events are the payment's, and billing admits them only from the payer
 * `start` recorded — so a Mini App payer who never signed in here, or whose
 * chat session expired, pays all the same.
 *
 * Not a flow. Neither event is an answer to a screen — the conversation ended
 * when `start` answered — so nothing here reads or writes navigation, and
 * neither event is ever routed into one.
 *
 * **A pre-checkout query is always answered.** The platform waits 10 seconds
 * and then cancels the payment, so a refusal nobody sends is still a refusal,
 * only one the payer cannot read. Whatever goes wrong on the way — billing
 * unreachable — becomes `ok: false` with a sentence.
 *
 * **A successful payment is said in the chat**, which is why billing marks that
 * credit `shownInChat` and the payer notice stays silent. Money that did not
 * credit is never told it did: billing keeps that payment verifying, and a
 * person sees it (F-092-y), so the payer is told it is being checked.
 */
@Injectable()
export class InChatPayment {
  private readonly logger = new Logger(InChatPayment.name);

  constructor(
    private readonly billing: BillingApiClient,
    private readonly copy: BotCopy,
  ) {}

  async handle(ctx: ChatContext, client: TelegramLikeBotClient): Promise<void> {
    const event = ctx.payment;
    if (!event) return;
    if (event.kind === 'pre_checkout') return this.preCheckout(ctx, event, client);
    return this.paid(ctx, event, client);
  }

  private async preCheckout(
    ctx: ChatContext,
    event: Extract<PaymentEvent, { kind: 'pre_checkout' }>,
    client: TelegramLikeBotClient,
  ): Promise<void> {
    const refuse = (text: BotText) =>
      client.answerPreCheckoutQuery(event.queryId, { ok: false, errorMessage: this.copy.text(ctx.lang, text) });

    const answer = await this.billing.preCheckout(bodyOf(ctx, event), ctx.lang);
    if (!answer.ok || !answer.data) {
      await refuse({ key: BotKeys.common.tryAgain });
      return;
    }
    const verdict = answer.data;
    if ('reason' in verdict) {
      await refuse({ key: REFUSAL_KEY[verdict.reason] ?? BotKeys.common.tryAgain });
      return;
    }
    await client.answerPreCheckoutQuery(event.queryId, { ok: true });
  }

  private async paid(
    ctx: ChatContext,
    event: Extract<PaymentEvent, { kind: 'payment_succeeded' }>,
    client: TelegramLikeBotClient,
  ): Promise<void> {
    const answer = await this.billing.paid({ ...bodyOf(ctx, event), chargeId: event.platformChargeId }, ctx.lang);
    const settled = answer.ok && answer.data && answer.data.credited !== null
      && (answer.data.status === 'credited' || answer.data.status === 'already_settled');

    if (!settled) {
      // The platform has the money and the wallet does not show it yet: billing
      // keeps it verifying for a person. Logged here too, with the charge id.
      this.logger.error(
        `${ctx.platform}: payment ${event.payload} charge ${event.platformChargeId} not credited: ` +
          `${answer.ok ? answer.data?.status : answer.msg}`,
      );
    }
    const text: BotText = settled
      ? { key: BotKeys.topUp.paidCredited, values: { credited: money(answer.data.credited as string, answer.data.currencyCode) } }
      : { key: BotKeys.topUp.paidPending };
    await client.sendMessage(ctx.chatId, this.copy.text(ctx.lang, text));
  }

}

function bodyOf(ctx: ChatContext, event: PaymentEvent): InChatPaymentBody {
  return {
    paymentId: event.payload,
    currency: event.currency,
    totalAmount: String(event.totalAmount),
    platform: ctx.platform,
    senderId: event.fromId,
    botTenantId: ctx.integration.tenantId,
  };
}
