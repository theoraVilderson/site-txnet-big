import { Inject, Injectable, Optional } from '@nestjs/common';
import { TRANSFER_REVIEW_CALLBACK_PREFIX } from '@txnet-backend/shared-core';
import { BotText } from '@txnet-backend/messenger';

import { ApiResult } from '../auth-api/auth-api.types';
import { BillingApiClient, BillingCallContext } from '../billing-api/billing-api.client';
import type { ManualAnswer, ManualQueueRow } from '../billing-api/transfer.types';
import { ChatContext, FlowResult } from '../conversation/nav.types';
import { BotCopy } from '../locale/bot-copy';
import { BotKey, BotKeys } from '../locale/bot-keys';
import { ChatAccess } from '../session/chat-access';
import { TRANSFER_FLOW_CLOCK } from './transfer-pay.flow';
import { keyIn, rejectAskView, reviewedView, reviewListView, reviewView, type ReviewAct } from './transfer.views';
import { say } from './views';

/**
 * The key a reviewer holds (billing's `PAYMENT_CONFIRM_MANUAL`, F-092-z). Read
 * off the token only to offer the menu row; billing refuses every tap without it.
 */
export const PAYMENT_CONFIRM_MANUAL = 'payment.confirm_manual';

/** A transfer waiting on a person: one whose payer sent the proof. */
type Waiting = ManualQueueRow & { transfer: NonNullable<ManualQueueRow['transfer']> };
const isWaiting = (r: ManualQueueRow): r is Waiting => r.transfer?.proofSubmittedAt != null;

/** What each of billing's outcomes says here; any other is a payment that no longer waits. */
const OUTCOMES: Partial<Record<string, BotKey>> = {
  confirmed_manually: BotKeys.transfer.review.confirmed,
  returned_for_proof: BotKeys.transfer.review.returned,
  rejected_manually: BotKeys.transfer.review.rejected,
  already_settled: BotKeys.transfer.review.settled,
  credited: BotKeys.transfer.review.settled,
};

/** The refusals of the manual-payments routes this chat words itself (F-092-af, F-805-a). */
const REFUSALS = {
  not_open: BotKeys.transfer.review.gone,
  payment_not_found: BotKeys.transfer.review.gone,
  duplicate_ref: BotKeys.transfer.review.duplicate,
  cannot_return: BotKeys.transfer.review.cannotReturn,
} as const;

/**
 * Judging a transfer's receipt from the chat (F-805-b): the receipts waiting,
 * one receipt with its picture, and confirm, send back or reject — the
 * manual-payments queue's own routes (F-092-z/af/ak, F-805-a), so the panel
 * and the chat judge one queue by one rule. The bot decides nothing: whose
 * receipts these are, whether a payment is still open and what each act does
 * are billing's.
 *
 * It holds no state: every button names its payment (`mtr:<act>:<id>`), so a
 * tap on an old screen — or on the proof notice auth-service sent — means what
 * it says. A confirm is one tap, judged on the screen it sits under; a reject
 * closes the payment for good, so it asks once more. The reason billing keeps
 * for each act is a fixed sentence in the reviewer's language.
 */
@Injectable()
export class TransferReviewFlow {
  private readonly now: () => Date;

  constructor(
    private readonly billing: BillingApiClient,
    private readonly access: ChatAccess,
    private readonly copy: BotCopy,
    @Optional() @Inject(TRANSFER_FLOW_CLOCK) now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  /** The receipts waiting on this person, oldest first. */
  async start(ctx: ChatContext): Promise<FlowResult> {
    const call = await this.callContext(ctx);
    if (!call) return signedOut();
    const queue = await this.billing.manualQueue(call);
    if (!queue.ok || !queue.data) return answered(said(queue));
    return { view: reviewListView(queue.data.filter(isWaiting)), nextState: null };
  }

  /** `mtr:l`, or `mtr:<act>:<paymentId>`. An act this build does not know opens the list. */
  async tap(ctx: ChatContext, actionId: string): Promise<FlowResult> {
    const [act, paymentId] = actionId.slice(TRANSFER_REVIEW_CALLBACK_PREFIX.length).split(':');
    if (!paymentId) return this.start(ctx);
    const call = await this.callContext(ctx);
    if (!call) return signedOut();
    switch (act as ReviewAct | 'o') {
      case 'o':
        return this.open(call, paymentId);
      case 'x':
        return { view: rejectAskView(paymentId), nextState: null };
      case 'c':
        return answered(said(await this.billing.confirmManual(paymentId, this.reason(ctx, BotKeys.transfer.review.reasonConfirm), call)));
      case 'r':
        return answered(said(await this.billing.rejectManual(paymentId, { reason: this.reason(ctx, BotKeys.transfer.review.reasonReturn), resubmit: true }, call)));
      case 'y':
        return answered(said(await this.billing.rejectManual(paymentId, { reason: this.reason(ctx, BotKeys.transfer.review.reasonReject), resubmit: false }, call)));
      default:
        return this.start(ctx);
    }
  }

  /**
   * One receipt. The queue has no single-payment route, so it is read and
   * searched; the picture comes from billing's bytes route — the signed URL is
   * a path on the gateway owner's panel Host, which this bot may not know.
   */
  private async open(call: BillingCallContext, paymentId: string): Promise<FlowResult> {
    const queue = await this.billing.manualQueue(call);
    if (!queue.ok || !queue.data) return answered(said(queue));
    const row = queue.data.find((r) => r.id === paymentId);
    if (!row || !isWaiting(row)) return answered({ key: BotKeys.transfer.review.gone });
    const picture = row.transfer.proof?.['receiptImage'] ? await this.billing.receipt(paymentId, call) : null;
    const shown = picture?.ok && picture.data ? picture.data : undefined;
    return { view: reviewView(row, { now: this.now(), pictureShown: !!shown }), nextState: null, ...(shown ? { picture: shown } : {}) };
  }

  /** The sentence billing keeps beside the act, in the reviewer's language (it must say who and why: a person, in the bot). */
  private reason(ctx: ChatContext, key: BotKey): string {
    return this.copy.text(ctx.lang, { key });
  }

  private async callContext(ctx: ChatContext): Promise<BillingCallContext | null> {
    const accessToken = await this.access.token(ctx);
    return accessToken ? { lang: ctx.lang, accessToken, platform: ctx.platform, botTenantId: ctx.integration.tenantId } : null;
  }
}

/** What an act did — billing's outcome, or its refusal — in this chat's words where it has them. */
function said(answer: ApiResult<ManualAnswer | ManualQueueRow[]>): BotText {
  if (answer.ok && answer.data && 'outcome' in answer.data) return { key: OUTCOMES[answer.data.outcome] ?? BotKeys.transfer.review.gone };
  const key = answer.error?.reason ? keyIn(REFUSALS, answer.error.reason) : undefined;
  return key ? { key } : { raw: answer.msg };
}

function answered(text: BotText): FlowResult {
  return { view: reviewedView(text), nextState: null };
}

function signedOut(): FlowResult {
  return { view: say('transfer.signedOut', { key: BotKeys.common.notSignedIn }), nextState: null };
}
