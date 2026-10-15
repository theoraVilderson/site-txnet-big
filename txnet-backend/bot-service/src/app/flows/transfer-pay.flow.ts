import { Inject, Injectable, Optional } from '@nestjs/common';
import { BotText } from '@txnet-backend/messenger';

import { ApiResult } from '../auth-api/auth-api.types';
import { BillingApiClient, BillingCallContext } from '../billing-api/billing-api.client';
import type { DepositTransfer, ProofAccepted } from '../billing-api/transfer.types';
import { ChatContext, FlowResult, NavState } from '../conversation/nav.types';
import { BotKeys } from '../locale/bot-keys';
import { ChatAccess } from '../session/chat-access';
import { ChatFiles } from './chat-files';
import {
  PAID_AGO_PREFIX,
  PAID_AT_FIELD,
  PROOF_DONE_ACTION,
  RECEIPT_FIELD,
  TRANSFER_PAY_PREFIX,
  fieldLabel,
  keyIn,
  nextStepView,
  payView,
  proofPrompt,
} from './transfer.views';
import { say } from './views';

/** The step every proof answer arrives at; the field asked is the first of `data.fields`. */
const PROOF_STEP = 'transfer.proof';
/** A collected answer's slot in nav state: `p:<field id>`. */
const ANSWER = 'p:';

/** An injectable clock for the specs (minutes left, "paid 10 minutes ago"). */
export const TRANSFER_FLOW_CLOCK = Symbol('TRANSFER_FLOW_CLOCK');

/**
 * Paying a manual transfer from the chat (F-805-b): the destination and the
 * exact amount a start answered, then the proof the seller asked for, one field
 * at a time — the receipt as a photo — handed to billing's own routes
 * (`billing/contract.manual-transfer.md`, F-805-a). The bot decides nothing:
 * whether a field is right, a reference new, a payment still open is billing's,
 * and a refusal is told by its `reason`.
 *
 * Only navigation is kept (ADR-0010): which payment, which fields are left, the
 * typed answers. The receipt is a commitment, so it is uploaded the moment it
 * arrives and only its key is remembered. Every screen's button names its
 * payment (`mtp:`), so a payer back after the conversation expired — or after
 * a reviewer sent the receipt back — starts from billing's own answer.
 */
@Injectable()
export class TransferPayFlow {
  private readonly now: () => Date;

  constructor(
    private readonly billing: BillingApiClient,
    private readonly access: ChatAccess,
    private readonly files: ChatFiles,
    @Optional() @Inject(TRANSFER_FLOW_CLOCK) now?: () => Date,
  ) {
    this.now = now ?? (() => new Date());
  }

  /** The pay screen for a transfer a start just answered (`TopUpFlow`), asking for its first proof. */
  show(paymentId: string, transfer: DepositTransfer): FlowResult {
    const minutesLeft = Math.max(0, Math.ceil((Date.parse(transfer.windowEndsAt) - this.now().getTime()) / 60_000));
    return {
      view: payView(paymentId, transfer, minutesLeft),
      nextState: { flow: 'transfer', step: PROOF_STEP, data: { paymentId, fields: transfer.requiredProof.join(',') } },
    };
  }

  /** `mtp:<paymentId>`: start the proof again from billing's answer, whatever the chat's state. */
  async tap(ctx: ChatContext, actionId: string): Promise<FlowResult> {
    const call = await this.callContext(ctx);
    if (!call) return signedOut();
    const paymentId = actionId.slice(TRANSFER_PAY_PREFIX.length);
    const read = await this.billing.transfer(paymentId, call);
    if (!read.ok || !read.data) return refused(read);
    if (read.data.status !== 'pending') return { view: say('transfer.closed', { key: BotKeys.transfer.closed }), nextState: null };
    if (read.data.proofSubmittedAt) return { view: say('transfer.alreadySent', { key: BotKeys.transfer.alreadySent }), nextState: null };
    return this.show(paymentId, read.data);
  }

  /** One answer to the field asked: a photo, a paid-at button, typed text — or "I have paid" when nothing is asked. */
  async handle(ctx: ChatContext, state: NavState, actionId: string | null): Promise<FlowResult> {
    const [field, ...rest] = (state.data.fields ?? '').split(',').filter(Boolean);
    if (field === undefined) return actionId === PROOF_DONE_ACTION ? this.submit(ctx, state) : again(state, field);

    const answer = await this.answerOf(ctx, state, field, actionId);
    if ('retry' in answer) return again(state, field, answer.retry);
    const next: NavState = { ...state, data: { ...state.data, fields: rest.join(','), [`${ANSWER}${field}`]: answer.value } };
    return rest.length ? { view: nextStepView(rest[0]), nextState: next } : this.submit(ctx, next);
  }

  /** The field's value as billing reads it, or why it must be asked again. Nothing here judges a value. */
  private async answerOf(ctx: ChatContext, state: NavState, field: string, actionId: string | null): Promise<{ value: string } | { retry: BotText }> {
    if (field === RECEIPT_FIELD) return this.upload(ctx, state.data.paymentId);
    if (field === PAID_AT_FIELD && actionId?.startsWith(PAID_AGO_PREFIX)) {
      const minutes = Number.parseInt(actionId.slice(PAID_AGO_PREFIX.length), 10) || 0;
      return { value: new Date(this.now().getTime() - minutes * 60_000).toISOString() };
    }
    const typed = actionId === null ? ctx.text?.trim() : undefined;
    return typed ? { value: typed } : { retry: { key: BotKeys.transfer.textExpected } };
  }

  /** The receipt is billing's the moment it arrives (ADR-0010): uploaded now, its key kept. */
  private async upload(ctx: ChatContext, paymentId: string): Promise<{ value: string } | { retry: BotText }> {
    if (!ctx.file) return { retry: { key: BotKeys.transfer.photoExpected } };
    const call = await this.callContext(ctx);
    if (!call) return { retry: { key: BotKeys.common.notSignedIn } };
    const file = await this.files.download(ctx, ctx.file);
    if (!file) return { retry: { key: BotKeys.transfer.fileUnreadable } };
    const stored = await this.billing.uploadReceipt(paymentId, file, call);
    if (!stored.ok || !stored.data) return { retry: refusalText(stored, RECEIPT_FIELD) };
    return { value: stored.data.key };
  }

  /** Every answer, by the kind's field ids; a refused field is asked again, the rest kept. */
  private async submit(ctx: ChatContext, state: NavState): Promise<FlowResult> {
    const call = await this.callContext(ctx);
    if (!call) return signedOut();
    const proof = Object.fromEntries(
      Object.entries(state.data).flatMap(([k, v]) => (k.startsWith(ANSWER) ? [[k.slice(ANSWER.length), v]] : [])),
    );
    const sent: ApiResult<ProofAccepted> = await this.billing.submitProof(state.data.paymentId, proof, call);
    if (sent.ok) return { view: say('transfer.sent', { key: BotKeys.transfer.sent }), nextState: null };

    const wrong = Object.keys(sent.error?.facts ?? {}).find((id) => id in proof) ?? (sent.error?.reason === 'receipt_missing' ? RECEIPT_FIELD : undefined);
    if (!wrong) return refused(sent);
    // Only the refused field is asked again: the others were taken, and stay.
    const kept = Object.fromEntries(Object.entries(state.data).filter(([k]) => k !== `${ANSWER}${wrong}`));
    return again({ ...state, data: { ...kept, fields: wrong } }, wrong, refusalText(sent, wrong));
  }

  private async callContext(ctx: ChatContext): Promise<BillingCallContext | null> {
    const accessToken = await this.access.token(ctx);
    return accessToken ? { lang: ctx.lang, accessToken, platform: ctx.platform, botTenantId: ctx.integration.tenantId } : null;
  }
}

/** The same field asked again, with why when there is a why. */
function again(state: NavState, field: string | undefined, hint?: BotText): FlowResult {
  return { view: nextStepView(field, hint ?? { key: BotKeys.common.pickOne }), nextState: state };
}

/** Billing's refusal in this chat's words when it names one this build words (`transfer.refused.*`), else its own sentence. */
function refusalText(answer: ApiResult<unknown>, field: string): BotText {
  const key = answer.error?.reason ? keyIn(BotKeys.transfer.refused, answer.error.reason) : undefined;
  return key ? { key, values: { field: fieldLabel(field), ask: proofPrompt(field) } } : { raw: answer.msg };
}

function refused(answer: ApiResult<unknown>): FlowResult {
  return { view: say('transfer.refused', refusalText(answer, RECEIPT_FIELD)), nextState: null };
}

function signedOut(): FlowResult {
  return { view: say('transfer.signedOut', { key: BotKeys.common.notSignedIn }), nextState: null };
}
