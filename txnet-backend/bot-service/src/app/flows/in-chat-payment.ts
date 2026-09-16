import { Injectable, Logger } from '@nestjs/common';
import { BotText, PaymentEvent, TelegramLikeBotClient } from '@txnet-backend/messenger';
import { BillingApiClient, BillingCallContext, InChatPaymentBody, PreCheckoutVerdict } from '../billing-api/billing-api.client';
import { ChatContext } from '../conversation/nav.types';
import { BotCopy } from '../locale/bot-copy';
import { BotKeys } from '../locale/bot-keys';
import { ChatAccess } from '../session/chat-access';

type Refusal = Extract<PreCheckoutVerdict, { approved: false }>['reason'];

/** Every refusal billing can give has a sentence; a new one does not compile until it gets one. */
const REFUSAL_KEY: Record<Refusal, string> = {
  not_found: BotKeys.topUp.refusedNotFound,
  not_payable: BotKeys.topUp.refusedNotPayable,
  amount_mismatch: BotKeys.topUp.refusedAmount,
};

/**
 * The bot's half of an in-chat payment (F-104-m, D-32): the two events the
 * messenger reports (F-104-l), relayed to billing (F-104-k) as the payer.
 *
 * Not a flow. Neither event is an answer to a screen — the conversation ended
 * when `start` answered — so nothing here reads or writes navigation, and
 * neither event is ever routed into one.
 *
 * **A pre-checkout query is always answered.** The platform waits 10 seconds
 * and then cancels the payment, so a refusal nobody sends is still a refusal,
 * only one the payer cannot read. Whatever goes wrong on the way — a signed-out
 * chat, billing unreachable — becomes `ok: false` with a sentence.
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
    private readonly access: ChatAccess,
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

    const call = await this.callContext(ctx);
    if (!call) {
      await refuse({ key: BotKeys.common.notSignedIn });
      return;
    }
    const answer = await this.billing.preCheckout(bodyOf(event), call);
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
    const call = await this.callContext(ctx);
    const answer = call
      ? await this.billing.paid({ ...bodyOf(event), chargeId: event.platformChargeId }, call)
      : null;
    const settled = answer?.ok && answer.data && answer.data.credited !== null
      && (answer.data.status === 'credited' || answer.data.status === 'already_settled');

    if (!settled) {
      // The platform has the money and the wallet does not show it yet: billing
      // keeps it verifying for a person. Logged here too, with the charge id.
      this.logger.error(
        `${ctx.platform}: payment ${event.payload} charge ${event.platformChargeId} not credited: ` +
          (answer ? `${answer.ok ? answer.data?.status : answer.msg}` : 'chat signed out'),
      );
    }
    const text: BotText = settled
      ? { key: BotKeys.topUp.paidCredited, values: { credited: answer.data.credited as string } }
      : { key: BotKeys.topUp.paidPending };
    await client.sendMessage(ctx.chatId, this.copy.text(ctx.lang, text));
  }

  private async callContext(ctx: ChatContext): Promise<BillingCallContext | null> {
    const accessToken = await this.access.token(ctx);
    return accessToken ? { lang: ctx.lang, accessToken, platform: ctx.platform } : null;
  }
}

function bodyOf(event: PaymentEvent): InChatPaymentBody {
  return { paymentId: event.payload, currency: event.currency, totalAmount: String(event.totalAmount) };
}
