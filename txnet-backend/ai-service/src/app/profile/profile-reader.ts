import { Injectable } from '@nestjs/common';
import { GrantStatus, Prisma } from '@prisma/client';
import { METER_KEYS, TenantContext, tenantTransaction } from '@txnet-backend/shared-core';

import { AiReaderPrisma } from '../prisma/prisma.service';
import type { MeterCounter } from './meter-readings';
import type { PredictionContext } from './predictions';
import type { AccountInputs } from './profile-features';

/** One interactive transaction reads a whole page; the default 5 s is a busy page on a one-CPU container. */
const READ_TIMEOUT_MS = 30_000;

export type Account = { id: string; createdAt: Date };

/** Whether identity still has an account, deleted or not (F-038-s). */
export type AccountState = { id: string; deletedAt: Date | null };

/** What the reader adds to an account; the readings are `ai`'s own and come from the writer. */
export type ReaderInputs = Omit<AccountInputs, 'userId' | 'createdAt' | 'readings'>;

/**
 * Everything `ai-service` reads of other units for the profile (F-038-c),
 * through `txnet_ai_reader` only (invariant 7): the tables `reader-tables.ts`
 * names and the three `ai.reader_*` views. Every call runs in the caller's
 * tenant scope (`runWithTenant`), so RLS — or the view's own clause — shows
 * one tenant's rows and nothing else.
 */
@Injectable()
export class ProfileReader {
  constructor(private readonly reader: AiReaderPrisma) {}

  /** One page of the tenant's accounts, by id. A deleted account has no profile. */
  accounts(cursor: string | null, take: number): Promise<Account[]> {
    return tenantTransaction(this.reader, (tx) =>
      tx.user.findMany({
        where: { deletedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
        select: { id: true, createdAt: true },
        orderBy: { id: 'asc' },
        take,
      }),
    );
  }

  /** These accounts as identity shows them, deleted ones included; one it no longer has is absent (F-038-s). */
  accountStates(ids: string[]): Promise<AccountState[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return tenantTransaction(this.reader, (tx) =>
      tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, deletedAt: true } }),
    );
  }

  /** Whether the reader sees any account of the tenant — false is a read that proves nothing (F-038-s). */
  async seesAnyAccount(): Promise<boolean> {
    const one = await tenantTransaction(this.reader, (tx) => tx.user.findFirst({ select: { id: true } }));
    return one !== null;
  }

  /**
   * The counters of every active Grant of these accounts. A Grant's bytes are
   * its `vpn.traffic` meter (`consumedBytes`, which metering advances);
   * every other meter is its `grant_meter.consumed`. Product-agnostic past
   * that one name: a new meter key is read with no change here.
   */
  async counters(userIds: string[]): Promise<MeterCounter[]> {
    if (userIds.length === 0) return [];
    return tenantTransaction(
      this.reader,
      async (tx) => {
        const grants = await tx.grant.findMany({
          where: { userId: { in: userIds }, status: GrantStatus.active },
          select: { id: true, userId: true, consumedBytes: true },
        });
        const meters = await tx.grantMeter.findMany({
          where: { grantId: { in: grants.map((g) => g.id) }, meterKey: { not: METER_KEYS.vpnTraffic } },
          select: { grantId: true, meterKey: true, consumed: true },
        });
        const owner = new Map(grants.map((g) => [g.id, g.userId]));
        return [
          ...grants.map((g) => ({ userId: g.userId, grantId: g.id, meterKey: METER_KEYS.vpnTraffic as string, counter: g.consumedBytes })),
          ...meters.map((m) => ({ userId: owner.get(m.grantId) as string, grantId: m.grantId, meterKey: m.meterKey, counter: m.consumed })),
        ];
      },
      { timeout: READ_TIMEOUT_MS },
    );
  }

  /**
   * The money a prediction needs (F-038-d): each variant's price in force at
   * `now` — the tenant's own before the platform's, which RLS shows beside it —
   * and the tenant's deposit presets.
   */
  async money(variantIds: string[], now: Date): Promise<PredictionContext> {
    return tenantTransaction(this.reader, async (tx) => {
      const prices = new Map<string, { amount: Prisma.Decimal; currencyCode: string; own: boolean }>();
      if (variantIds.length > 0) {
        const rows = await tx.price.findMany({
          where: { variantId: { in: variantIds }, isActive: true, effectiveFrom: { lte: now } },
          select: { variantId: true, tenantId: true, amount: true, currencyCode: true },
          orderBy: { effectiveFrom: 'desc' },
        });
        // The scope's rows: its own and the platform's (ADR-0142).
        const scope = TenantContext.current('prediction prices').id;
        for (const r of rows) {
          const seen = prices.get(r.variantId);
          const own = r.tenantId === scope;
          if (!seen || (own && !seen.own)) prices.set(r.variantId, { amount: r.amount, currencyCode: r.currencyCode, own });
        }
      }
      const setting = await tx.depositSetting.findFirst({ select: { presets: true, currencyCode: true } });
      return {
        prices: new Map([...prices].map(([id, p]) => [id, { amount: p.amount, currencyCode: p.currencyCode }])),
        presets: setting && setting.presets.length > 0 ? { amounts: setting.presets, currencyCode: setting.currencyCode } : null,
      };
    });
  }

  /** The rest of each account's inputs since `since`, keyed by user id. */
  async inputs(userIds: string[], since: Date): Promise<Map<string, ReaderInputs>> {
    const out = new Map<string, ReaderInputs>(
      userIds.map((id) => [id, { grants: [], renewals: [], walletTransactions: [], wallet: null, payments: [], signIns: [], notices: [] }]),
    );
    if (userIds.length === 0) return out;
    const of = (userId: string) => out.get(userId) as ReaderInputs;
    const ids = Prisma.sql`ARRAY[${Prisma.join(userIds)}]::uuid[]`;

    await tenantTransaction(
      this.reader,
      async (tx) => {
        // One after the other: an interactive transaction is one connection.
        const grants = await tx.grant.findMany({
          where: { userId: { in: userIds }, OR: [{ status: GrantStatus.active }, { updatedAt: { gt: since } }] },
          select: {
            id: true,
            userId: true,
            variantId: true,
            source: true,
            status: true,
            billingMode: true,
            trafficUnlimited: true,
            purchasedBytes: true,
            consumedBytes: true,
            usagePeriodFromBytes: true,
            startsAt: true,
            activatedAt: true,
            endsAt: true,
            updatedAt: true,
          },
        });
        for (const { userId, ...g } of grants) of(userId).grants.push(g);

        const renewals = await tx.grantRenewal.findMany({
          where: { grantId: { in: grants.map((g) => g.id) }, createdAt: { gt: since } },
          select: { grantId: true, createdAt: true, plan: true, bytes: true, endsAtBefore: true, endsAtAfter: true },
          orderBy: { createdAt: 'asc' },
        });
        const grantOwner = new Map(grants.map((g) => [g.id, g.userId]));
        for (const r of renewals) of(grantOwner.get(r.grantId) as string).renewals.push(r);

        const payments = await tx.paymentTransaction.findMany({
          where: { userId: { in: userIds }, createdAt: { gt: since } },
          select: { userId: true, status: true, createdAt: true, discountApplied: true },
        });
        for (const { userId, ...p } of payments) of(userId).payments.push(p);

        const wallets = await tx.$queryRaw<Array<{ id: string; userId: string; cachedBalance: Prisma.Decimal; heldAmount: Prisma.Decimal; currencyCode: string }>>`
          SELECT "id", "userId", "cachedBalance", "heldAmount", "currencyCode" FROM ai.reader_wallet WHERE "userId" = ANY(${ids})`;
        for (const w of wallets) of(w.userId).wallet = { id: w.id, balance: w.cachedBalance, held: w.heldAmount, currencyCode: w.currencyCode };

        const walletOwner = new Map(wallets.map((w) => [w.id, w.userId]));
        const ledger = await tx.walletTransaction.findMany({
          where: { walletId: { in: wallets.map((w) => w.id) }, createdAt: { gt: since } },
          select: { walletId: true, direction: true, reasonType: true, createdAt: true },
        });
        for (const { walletId, ...t } of ledger) of(walletOwner.get(walletId) as string).walletTransactions.push(t);

        const signIns = await tx.$queryRaw<Array<{ userId: string; issuedAt: Date }>>`
          SELECT "userId", "issuedAt" FROM ai.reader_sign_in WHERE "userId" = ANY(${ids}) AND "issuedAt" > ${since}`;
        for (const s of signIns) of(s.userId).signIns.push(s.issuedAt);

        const notices = await tx.$queryRaw<Array<{ userId: string; createdAt: Date; readAt: Date | null }>>`
          SELECT "userId", "createdAt", "readAt" FROM ai.reader_notice WHERE "userId" = ANY(${ids}) AND "createdAt" > ${since}`;
        for (const n of notices) of(n.userId).notices.push({ createdAt: n.createdAt, readAt: n.readAt });
      },
      { timeout: READ_TIMEOUT_MS },
    );
    return out;
  }
}
