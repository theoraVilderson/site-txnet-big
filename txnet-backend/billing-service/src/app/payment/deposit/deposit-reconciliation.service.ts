import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConfirmationSource,
  PaymentStatus,
  Prisma,
  ReconciliationAction,
} from '@prisma/client';
import {
  CredentialUnavailable,
  TenantContext,
  runWithTenant,
  tenantTransaction,
} from '@txnet-backend/shared-core';

import type { EnvConfig } from '../../config/env.validation';
import { CrossTenantPrismaService } from '../../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../../prisma/prisma.service';
import { GatewayMerchant } from '../gateway/gateway-merchant';
import {
  GatewayCredentials,
  GatewayFailure,
  PaymentInquiryStatus,
  PaymentProvider,
} from '../gateway/payment-provider';
import { PaymentProviderRegistry } from '../gateway/payment-provider.registry';
import { PAYMENT_SELECT, PaymentRow, DepositSettlementService, gatewayRefOf } from './deposit-settlement';
import { attachAuthority, paymentIdInUrl, withdrawAuthority } from './payment-callback-url';
import { clearVerifyRetry, flagLongVerifying, scheduleVerifyRetry } from './verify-retry';

/**
 * Going and asking (F-092-l).
 *
 * The callback settles a payment whose payer came back. F-092-k closes the
 * clock on the ones who did not. Between them sits the case both leave open on
 * purpose: **a payment the gateway could not be reached about.** A verify that
 * timed out, an amount the bank reported differently, an authority minted and
 * then met with silence — F-092-j leaves every one of those `pending` rather
 * than guessing, precisely so that something can come back later and ask. This
 * is that something.
 *
 * **It credits and it flags. It never closes and it never reverses.**
 * (invariant 9.) The only write it makes to a payment is the credit a gateway
 * confirmed, through the same guarded path the callback uses. A gateway saying
 * `failed` or `reversed` is written to `payment_reconciliation_log` and nothing
 * else: the clock (F-092-k) is what closes a row, an auto-reversal is the one
 * write this table can never take back, and `ReconciliationAction` has exactly
 * three words for a reason — confirm, flag, or leave alone.
 *
 * **An answer the gateway could not give writes no log row at all.** A row
 * saying "checked, nothing to do" is what makes the payment invisible to every
 * later sweep, and a timeout is not an answer. So an `unavailable` inquiry, an
 * unreadable merchant id and any unexpected error are counted as errors of the
 * run and leave the payment exactly where it was, due to be asked about again.
 * An `authority_invalid` **is** an answer — the gateway does not know this
 * authority and never will — so that one is recorded.
 *
 * **The scan is cross-tenant, every call and write is scoped**, for the reason
 * `deposit-expiry.service.ts` gives: which tenants have a payment to ask about
 * is what the sweep is looking for, and the vault read that follows is bound to
 * one tenant by ADR-0039.
 *
 * Legacy's `ZarinpalProvider.isVerified` (codes 100/101) is the same idea with
 * no home: it was a helper nothing scheduled, so a payment that fell through
 * the callback fell through for good.
 */

/** What one reconciliation run did. */
export type DepositReconciliationResult = {
  /** Payments the scan found due to be asked about, at most one batch. */
  scanned: number;
  /** Payments this run confirmed and credited. */
  confirmed: number;
  /** Payments whose gateway reported a different amount — recorded, never settled. */
  flagged: number;
  /** Payments asked about, with nothing to do: in the bank, failed, reversed, or already settled. */
  unchanged: number;
  /** Payments the gateway would not answer about. No log row; the next run asks again. */
  errors: number;
  /** Payments this run found still verifying a day after they were made, and flagged for a person (F-092-y). */
  flaggedForPerson: number;
  /** Payments whose lost authority this run found in the gateway's unverified list (F-092-ad). */
  authoritiesRecovered?: number;
};

/**
 * What asking about one payment came to — the detail a person needs (F-092-z),
 * which a run folds into its counts.
 */
export type AskKind =
  /** The gateway confirmed it and this call credited it. */
  | 'credited'
  /** The gateway confirmed it and another path had already credited it. */
  | 'already_settled'
  /** The gateway took a different amount: `flagged_mismatch`. */
  | 'mismatch'
  /** A settled no: `failed`, `reversed`, or an authority the gateway does not know. */
  | 'refused'
  /** Not finished at the bank. Unsettled. */
  | 'in_bank'
  /** No answer — a timeout, an unreadable merchant id, anything unexpected. Unsettled. */
  | 'unanswered'
  /** The row carries no authority, or is not readable in its tenant's scope. */
  | 'unaskable';

export type AskAnswer = { kind: AskKind; gatewayStatus: string | null; referenceId: string | null };

type Outcome = 'confirmed' | 'flagged' | 'unchanged' | 'errors';

const COUNTED_AS: Record<AskKind, Outcome> = {
  credited: 'confirmed',
  already_settled: 'unchanged',
  mismatch: 'flagged',
  refused: 'unchanged',
  in_bank: 'unchanged',
  unanswered: 'errors',
  unaskable: 'errors',
};

const answer = (kind: AskKind, gatewayStatus: string | null = null, referenceId: string | null = null): AskAnswer => ({
  kind,
  gatewayStatus,
  referenceId,
});

/** Called wherever an answer was not settled: schedule the next ask, flag if it is a day old. */
type RetryHook = (payment: PaymentRow) => Promise<void>;

/**
 * How old an authority-less payment must be before its gateway's unverified
 * list is searched for it (F-092-ad): `start` writes the authority a moment
 * after the gateway answers, and a younger row is most likely still in there.
 */
export const AUTHORITY_RECOVERY_AFTER_SEC = 120;

/** How overdue a retry must be before the sweep stands in for `deposit_verify_retry` (F-092-ac). */
export const VERIFY_RETRY_STALLED_SEC = 600;

/** Inquiry answers that mean the money is at the gateway and a `verify` should be attempted. */
const PAYABLE: readonly PaymentInquiryStatus[] = ['verified', 'paid'];

/**
 * A row there is something to ask the gateway about: its own authority, or one
 * offered for it (F-092-ag). A row with neither was never minted, or lost its
 * authority to a write nobody has recovered yet.
 */
const ASKABLE = [
  { gatewayTrackingCode: { not: null } },
  { authorityCandidates: { isEmpty: false } },
] satisfies Prisma.PaymentTransactionWhereInput[];

/**
 * What the gateway said about an **offered** authority (F-092-ag): it confirmed
 * the payment at this row's amount, it disowned the authority for this row, or
 * it said nothing that settles either.
 */
type CandidateVerdict =
  | { kind: 'confirmed'; status: PaymentInquiryStatus; verified: { referenceId: string; cardPan: string | null } }
  | { kind: 'disowned' }
  | { kind: 'silent' };

/**
 * The gateway's refusals that are about **this authority for this payment**. A
 * merchant-wide failure (`merchant_rejected`, `rate_limited`, `unavailable`, …)
 * says nothing about the candidate, so it is kept and asked again.
 */
const DISOWNS = ['authority_invalid', 'amount_mismatch', 'payment_failed'];

@Injectable()
export class DepositReconciliationService {
  private readonly logger = new Logger(DepositReconciliationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crossTenant: CrossTenantPrismaService,
    private readonly providers: PaymentProviderRegistry,
    private readonly merchant: GatewayMerchant,
    private readonly settlement: DepositSettlementService,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  /**
   * The ordinary sweep (F-092-l): `expired` rows, and `pending` rows past their
   * clock that are not verifying. Verifying rows are `verifyDue`'s, on its own
   * minute job (F-092-ac, ADR-0046 decision 3).
   */
  async reconcile(): Promise<DepositReconciliationResult> {
    const now = new Date();
    const take = this.config.get('RECONCILIATION_BATCH_SIZE', { infer: true });
    const recheckSec = this.config.get('RECONCILIATION_RECHECK_SEC', { infer: true });

    // 0. Authorities whose write was lost, found in the gateway's own list, so
    //    the scans below can ask about those payments like any other.
    const authoritiesRecovered = await this.recoverAuthorities(now, take);

    // 1. A safety net, not a schedule: a verifying row whose retry is ten
    //    minutes overdue means `deposit_verify_retry` is not running — a
    //    deployment whose seed was not re-run — and a payer must not be
    //    stranded by that. Taken first, like the retries it stands in for.
    const stalled = await this.dueVerifying(now, new Date(now.getTime() - VERIFY_RETRY_STALLED_SEC * 1000), take);

    // 2. The ordinary rows, in whatever room is left.
    const ordinary =
      stalled.length >= take
        ? []
        : await this.crossTenant.paymentTransaction.findMany({
            where: {
              // `expired` is the ordinary case — F-092-k gets there first — and a
              // `pending` row past its clock is one the sweep has not reached yet.
              // A verifying row is `verifyDue`'s, never this scan's.
              AND: [
                {
                  OR: [
                    { status: PaymentStatus.expired },
                    { status: PaymentStatus.pending, expiresAt: { lte: now }, nextVerifyAt: null },
                  ],
                },
                // No authority, and none offered, means there is nothing on the
                // gateway's side to ask about.
                { OR: ASKABLE },
              ],
              createdAt: this.lookback(now),
              // Asked recently enough is asked. Without this the oldest unresolvable
              // payment would fill every batch for ever.
              reconciliationLogs: {
                none: { checkedAt: { gte: new Date(now.getTime() - recheckSec * 1000) } },
              },
            },
            select: { id: true, tenantId: true },
            orderBy: { createdAt: 'asc' },
            take: take - stalled.length,
          });
    return { ...(await this.askAll([...stalled, ...ordinary], now)), authoritiesRecovered };
  }

  /**
   * An open payment with no authority — `start`'s write of it was lost after
   * the gateway minted one — is looked for in its gateway's list of paid,
   * unverified payments (F-092-ad, ADR-0046 decision 4). An entry is attached
   * only when its callback URL names **this** payment (`?p=`) **and** its amount
   * is the row's `chargedAmountMinor`: the amount alone would confuse two
   * payments of one price. A gateway with no such list, or one that does not
   * answer, recovers nothing this run and is asked again the next.
   */
  private async recoverAuthorities(now: Date, take: number): Promise<number> {
    const rows = await this.crossTenant.paymentTransaction.findMany({
      where: {
        gatewayTrackingCode: null,
        status: { in: [PaymentStatus.pending, PaymentStatus.expired] },
        createdAt: { ...this.lookback(now), lte: new Date(now.getTime() - AUTHORITY_RECOVERY_AFTER_SEC * 1000) },
      },
      select: { ...PAYMENT_SELECT, tenantId: true },
      orderBy: { createdAt: 'asc' },
      take,
    });

    // One list per merchant account a row can name: tenant, gateway column and grant.
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      if (!row.tenantId) continue;
      const key = [row.tenantId, row.gatewayId, row.tenantGatewayConfigId, row.grantId].join('|');
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    let recovered = 0;
    for (const group of groups.values()) {
      recovered += await runWithTenant({ id: group[0].tenantId as string }, async () => {
        const ref = gatewayRefOf(group[0]);
        const provider = this.providers.get(ref.providerName);
        if (!provider.listUnverified) return 0;
        let list;
        try {
          const credentials = await this.merchant.credentialsFor(ref, group[0].userId);
          list = await provider.listUnverified({ credentials });
        } catch (e) {
          this.logger.warn(`unverified list of gateway ${ref.gatewayId} not read: ${e instanceof Error ? e.message : String(e)}`);
          return 0;
        }
        let attached = 0;
        for (const row of group) {
          const entry = list.find((u) => paymentIdInUrl(u.callbackUrl) === row.id && u.amountMinor === row.chargedAmountMinor);
          if (!entry) continue;
          try {
            if (await tenantTransaction(this.prisma, (tx) => attachAuthority(tx, row.id, entry.authority))) {
              this.logger.warn(`payment ${row.id} recovered its lost authority from the gateway's unverified list`);
              attached++;
            }
          } catch (e) {
            // The unique index: another payment already holds this authority.
            this.logger.error(`payment ${row.id}: authority from the unverified list not attached: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        return attached;
      });
    }
    return recovered;
  }

  /**
   * Verifying rows whose retry has come (F-092-y), run every tick by
   * `deposit_verify_retry` (F-092-ac). Their own clock is the whole of their
   * due-ness: neither `expiresAt` nor the recheck window applies, since the
   * ladder already spaces the asks.
   */
  async verifyDue(): Promise<DepositReconciliationResult> {
    const now = new Date();
    const take = this.config.get('RECONCILIATION_BATCH_SIZE', { infer: true });
    return this.askAll(await this.dueVerifying(now, now, take), now);
  }

  private dueVerifying(now: Date, dueBy: Date, take: number): Promise<Array<{ id: string; tenantId: string | null }>> {
    return this.crossTenant.paymentTransaction.findMany({
      where: {
        status: PaymentStatus.pending,
        nextVerifyAt: { lte: dueBy },
        OR: ASKABLE,
        createdAt: this.lookback(now),
      },
      select: { id: true, tenantId: true },
      orderBy: { nextVerifyAt: 'asc' },
      take,
    });
  }

  /**
   * A window, not for ever: a gateway's own records are not unbounded either,
   * and a payment nobody has claimed in a week is an operator's question
   * rather than a job's. It bounds the retries too (ADR-0044 decision 5).
   */
  private lookback(now: Date): { gte: Date } {
    const lookbackSec = this.config.get('RECONCILIATION_LOOKBACK_SEC', { infer: true });
    return { gte: new Date(now.getTime() - lookbackSec * 1000) };
  }

  private async askAll(
    due: Array<{ id: string; tenantId: string | null }>,
    now: Date,
  ): Promise<DepositReconciliationResult> {
    const result: DepositReconciliationResult = {
      scanned: due.length,
      confirmed: 0,
      flagged: 0,
      unchanged: 0,
      errors: 0,
      flaggedForPerson: 0,
    };
    const onRetry = async (payment: PaymentRow) => {
      if (await this.scheduleRetry(payment, now)) result.flaggedForPerson++;
    };

    for (const row of due) {
      if (!row.tenantId) {
        // Same fault the expiry sweep reports: the app pool cannot read it, so
        // it cannot be asked about either.
        this.logger.error(`payment ${row.id} carries no tenantId and cannot be reconciled`);
        result.errors++;
        continue;
      }
      const asked = await runWithTenant({ id: row.tenantId }, () => this.reconcileOne(row.id, onRetry));
      result[COUNTED_AS[asked.kind]]++;
    }

    if (result.flaggedForPerson > 0) {
      this.logger.warn(`${result.flaggedForPerson} payment(s) still verifying past their flag time, flagged for a person`);
    }
    if (result.confirmed > 0 || result.flagged > 0) {
      this.logger.log(
        `reconciled ${result.scanned}: ${result.confirmed} confirmed, ${result.flagged} flagged, ${result.errors} unanswered`,
      );
    }
    return result;
  }

  /**
   * Ask about one payment now, by exactly the rules a run follows — the credit,
   * the log row, the retry clock and the flag (F-092-z: a person's "inquire"
   * and the first step of a manual confirmation). The caller has already bound
   * the payment's own tenant.
   */
  async askOnce(paymentId: string): Promise<AskAnswer> {
    const now = new Date();
    return this.reconcileOne(paymentId, async (payment) => {
      await this.scheduleRetry(payment, now);
    });
  }

  /**
   * One payment, inside its own tenant's scope.
   *
   * Everything that talks to a gateway happens **outside** every transaction —
   * the vault read, the inquiry and the verify — for the reason ADR-0028 gives
   * the callback: a connection held open across a call to a bank is a
   * connection nobody else can have, and a sweep holds it for a whole batch.
   */
  private async reconcileOne(paymentId: string, onRetry: RetryHook): Promise<AskAnswer> {
    const payment = await tenantTransaction(this.prisma, (tx) =>
      tx.paymentTransaction.findFirst({ where: { id: paymentId }, select: PAYMENT_SELECT }),
    );
    if (!payment) {
      // The cross-tenant scan saw it and the tenant-scoped read did not, which
      // means the row's `tenantId` disagrees with the one it was grouped under.
      this.logger.error(`payment ${paymentId} is not readable inside its own tenant scope`);
      return answer('unaskable');
    }

    const authority = payment.gatewayTrackingCode;
    if (!authority) {
      return payment.authorityCandidates?.length ? await this.askCandidates(payment, onRetry) : answer('unaskable');
    }

    const ref = gatewayRefOf(payment);
    const provider = this.providers.get(ref.providerName);

    let status: PaymentInquiryStatus;
    try {
      const credentials = await this.merchant.credentialsFor(ref, payment.userId);
      ({ status } = await provider.inquire({ credentials, authority }));
    } catch (e) {
      return await this.unanswered(payment, e, onRetry);
    }

    if (!PAYABLE.includes(status)) {
      // `in_bank` is not finished, `failed` and `reversed` are finished and owe
      // nothing. `in_bank` is not a settled answer, so a pending row keeps
      // verifying (F-092-x); `failed` and `reversed` are, so its retry clock
      // stops. Only `reversed` closes the row, beside its log row: the bank is
      // returning the money, and the payer is told (F-092-ae, ADR-0046
      // decision 5). `failed` still closes nothing — the clock owns that.
      await this.record(
        payment,
        status,
        ReconciliationAction.no_action_needed,
        undefined,
        status !== 'in_bank',
        status === 'reversed' ? (tx) => this.settlement.closeReversed(tx, payment) : undefined,
      );
      if (status === 'in_bank') {
        await onRetry(payment);
        return answer('in_bank', status);
      }
      return answer('refused', status);
    }

    return await this.confirm(payment, authority, status, onRetry);
  }

  /**
   * A payment with no authority of its own but authorities **offered** for it
   * (F-092-ag, ADR-0047 decision 1). Each is asked about in turn, by the rules
   * the row's own authority would be — inquire, then verify at the row's amount.
   *
   * The first the gateway confirms is credited and attached in the crediting
   * flip (guarded `gatewayTrackingCode: null`). One it disowns — unknown, paid at
   * another amount, not paid — is taken back off the row and **nothing else
   * happens**: no log row, no flag, no close, because an unproven authority is
   * not evidence about this payment. Silence about any keeps them all and
   * schedules the next ask. When every candidate was disowned there is nothing
   * left to ask about, which is `unaskable` — the answer that lets a person
   * confirm by hand.
   */
  private async askCandidates(payment: PaymentRow, onRetry: RetryHook): Promise<AskAnswer> {
    const ref = gatewayRefOf(payment);
    const provider = this.providers.get(ref.providerName);
    let credentials: GatewayCredentials;
    try {
      credentials = await this.merchant.credentialsFor(ref, payment.userId);
    } catch (e) {
      return await this.unanswered(payment, e, onRetry);
    }

    let silent = false;
    for (const candidate of payment.authorityCandidates) {
      const verdict = await this.askCandidate(provider, credentials, payment, candidate);
      if (verdict.kind === 'silent') {
        silent = true;
        continue;
      }
      if (verdict.kind === 'disowned') {
        await tenantTransaction(this.prisma, (tx) => withdrawAuthority(tx, payment.id, candidate));
        this.logger.warn(`payment ${payment.id}: an offered authority was disowned by the gateway and taken back`);
        continue;
      }
      const credited = await this.settlement.creditVerified(
        payment,
        { ...verdict.verified, authority: candidate },
        ConfirmationSource.reconciliation_auto,
      );
      await this.record(
        payment,
        verdict.status,
        credited ? ReconciliationAction.auto_confirmed : ReconciliationAction.no_action_needed,
        credited
          ? `credited through an offered authority, reference ${verdict.verified.referenceId}`
          : 'already settled by another path',
      );
      return answer(credited ? 'credited' : 'already_settled', verdict.status, verdict.verified.referenceId);
    }

    if (!silent) return answer('unaskable');
    await onRetry(payment);
    return answer('unanswered');
  }

  private async askCandidate(
    provider: PaymentProvider,
    credentials: GatewayCredentials,
    payment: PaymentRow,
    authority: string,
  ): Promise<CandidateVerdict> {
    const verdictOf = (e: unknown): CandidateVerdict =>
      e instanceof GatewayFailure && DISOWNS.includes(e.reason) ? { kind: 'disowned' } : { kind: 'silent' };

    let status: PaymentInquiryStatus;
    try {
      ({ status } = await provider.inquire({ credentials, authority }));
    } catch (e) {
      return verdictOf(e);
    }
    if (status === 'in_bank') return { kind: 'silent' };
    if (!PAYABLE.includes(status)) return { kind: 'disowned' };

    try {
      const verified = await provider.verify({ credentials, authority, amountMinor: payment.chargedAmountMinor });
      return { kind: 'confirmed', status, verified };
    } catch (e) {
      return verdictOf(e);
    }
  }

  /** The gateway says the money is there. Take it, through the one guarded path. */
  private async confirm(
    payment: PaymentRow,
    authority: string,
    status: PaymentInquiryStatus,
    onRetry: RetryHook,
  ): Promise<AskAnswer> {
    const ref = gatewayRefOf(payment);
    const provider = this.providers.get(ref.providerName);

    let verified: { referenceId: string; cardPan: string | null };
    try {
      const credentials = await this.merchant.credentialsFor(ref, payment.userId);
      verified = await provider.verify({
        credentials,
        authority,
        // The amount the row was charged at, never recomputed: re-pricing at
        // settlement time is how a rate that moved becomes a mismatch
        // (ADR-0019, invariant 12).
        amountMinor: payment.chargedAmountMinor,
      });
    } catch (e) {
      if (e instanceof GatewayFailure && e.reason === 'amount_mismatch') {
        // The one outcome this job exists to surface. Crediting either figure
        // would be inventing a price, and closing the row would hide a payment
        // somebody's money is sitting behind — so it is written down for a
        // person, and nothing else happens.
        await this.record(payment, status, ReconciliationAction.flagged_mismatch, e.message, true);
        this.logger.warn(`payment ${payment.id} flagged: ${e.message}`);
        return answer('mismatch', status);
      }
      return await this.unanswered(payment, e, onRetry, status);
    }

    const credited = await this.settlement.creditVerified(
      payment,
      verified,
      // The enum's second word, and the whole reason it has three: this credit
      // was taken by a sweep, not brought back by a payer's browser.
      ConfirmationSource.reconciliation_auto,
    );
    await this.record(
      payment,
      status,
      credited ? ReconciliationAction.auto_confirmed : ReconciliationAction.no_action_needed,
      credited ? `credited, reference ${verified.referenceId}` : 'already settled by another path',
    );
    return answer(credited ? 'credited' : 'already_settled', status, verified.referenceId);
  }

  /**
   * The gateway did not answer — or could not be asked.
   *
   * `authority_invalid` is the exception: that *is* an answer, and a final one,
   * so it is recorded and the payment stops being re-asked about. Everything
   * else leaves no trace at all, on purpose.
   */
  private async unanswered(
    payment: PaymentRow,
    cause: unknown,
    onRetry: RetryHook,
    /** What `inquire` said before the `verify` that went unanswered, if it got that far. */
    inquired: string | null = null,
  ): Promise<AskAnswer> {
    if (cause instanceof GatewayFailure && cause.reason === 'authority_invalid') {
      await this.record(payment, 'authority_invalid', ReconciliationAction.no_action_needed, cause.message, true);
      return answer('refused', 'authority_invalid');
    }
    // Silence schedules the next ask, exactly as at the callback (F-092-x).
    await onRetry(payment);
    const what = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    // A credential this job cannot read is the same shape as a gateway that did
    // not answer: unknown, and worth asking again rather than recording.
    if (!(cause instanceof GatewayFailure) && !(cause instanceof CredentialUnavailable)) {
      this.logger.error(`payment ${payment.id} could not be reconciled: ${what}`);
    } else {
      this.logger.warn(`payment ${payment.id} not answered for: ${what}`);
    }
    return answer('unanswered', inquired);
  }

  /**
   * The next rung of the retry ladder (F-092-x), and the flag for a person once
   * the payment has been verifying for a day (F-092-y) — or, on a gateway that
   * returns an unverified payment, for half its window (F-092-ae, ADR-0046
   * decision 6), while a person can still act — in one transaction. Only a
   * `pending` row climbs, so asking about an `expired` one schedules nothing.
   * Answers whether this call flagged it.
   */
  private async scheduleRetry(payment: PaymentRow, now: Date): Promise<boolean> {
    if (payment.status !== PaymentStatus.pending) return false;
    const window = this.providers.get(gatewayRefOf(payment).providerName).verifyWindowSec;
    const flagAfterSec = Math.min(
      this.config.get('VERIFY_FLAG_AFTER_SEC', { infer: true }),
      window === null ? Infinity : Math.floor(window / 2),
    );
    const flagBefore = new Date(now.getTime() - flagAfterSec * 1000);
    return tenantTransaction(this.prisma, async (tx) => {
      const scheduled = await scheduleVerifyRetry(tx, payment, now);
      return scheduled !== null && (await flagLongVerifying(tx, payment.id, flagBefore, now));
    });
  }

  /**
   * The audit row — the whole point of the job as much as the credit is.
   *
   * `gatewayReportedStatus` is what the gateway said, in its own words, because
   * a mismatch is investigated by a person who needs the answer and not our
   * reading of it. `payment_reconciliation_log` carries no `tenantId` of its
   * own: it hangs off a payment that does, and so is not one of the tables
   * `20260909001500_row_level_security_all_tables` had a policy shape for.
   */
  private async record(
    payment: PaymentRow,
    reported: string,
    action: ReconciliationAction,
    notes?: string,
    /** The answer is settled: a verifying row stops verifying, in the same transaction. */
    settled = false,
    /** A write that must commit with the log row (F-092-ae: closing a reversed payment). */
    alsoIn?: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ): Promise<void> {
    const tenant = TenantContext.current('reconciliation log');
    await tenantTransaction(this.prisma, async (tx) => {
      await (tx as Prisma.TransactionClient).paymentReconciliationLog.create({
        data: {
          paymentTransactionId: payment.id,
          gatewayReportedStatus: reported,
          actionTaken: action,
          notes: notes ?? null,
        },
        select: { id: true },
      });
      if (settled && payment.nextVerifyAt) await clearVerifyRetry(tx, payment.id);
      if (alsoIn) await alsoIn(tx);
    });
    this.logger.debug(`payment ${payment.id} of tenant ${tenant.id}: ${reported} -> ${action}`);
  }
}
