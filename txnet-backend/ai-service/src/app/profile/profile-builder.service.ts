import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { DecisionRun } from '../decision/decision-run';
import { ResellerDecisionRun } from '../decision/reseller-decision';
import { OutcomeRun } from '../decision/outcome-run';
import type { AiTenantMode } from '../policy/ai-defaults';
import { AiTenantPolicy } from '../policy/ai-tenant-policy';
import { PrismaService } from '../prisma/prisma.service';
import { meterRef, readingsFor, utcHour, type MeterReadingRow } from './meter-readings';
import { predictions, type PredictionRow } from './predictions';
import { accountFeatures, PROFILE_HISTORY_DAYS, type AccountInputs } from './profile-features';
import { ProfileReader, type ReaderInputs } from './profile-reader';
import { resellerPredictions } from './reseller-predictions';
import { ResellerReader } from './reseller-reader';
import { Retention } from './retention';
import { walletNeedPrediction, walletRunOut } from './usage-forecast';

const DAY_MS = 86_400_000;
/** Accounts per page: one reader transaction and one writer transaction each, bounded memory on a 512 MB container. */
const PROFILE_PAGE = 500;
const WRITE_TIMEOUT_MS = 30_000;

export type RebuildResult = { tenants: number; skipped: number; accounts: number; readings: number; predictions: number; purged: number; erased: number; scheduled: number; stopped: number; converted: number; resellers: number };

/** The kinds this builder owns: each run replaces an account's rows of these and no others. */
const V1_KINDS = ['meter_exhaustion', 'renewal_probability', 'right_size', 'wallet_need', 'trial_conversion', 'win_back_window'] as const;

/** A reseller's kinds (F-038-o1): subject `tenant`, written in the platform's tenant only. */
const RESELLER_KINDS = ['quota_exhaustion', 'churn_risk', 'wallet_need'] as const;

/**
 * The hourly profile rebuild (F-038-c, ADR-0109 points 6, 7, 14). For every
 * tenant whose engine runs (F-1550, F-038-x — `AiTenantPolicy`, the same rule
 * a trigger obeys), page by page over its accounts:
 *
 * 1. sample each active Grant's meters into `ai.meter_reading`;
 * 2. read 180 days of the account's inputs through the reader;
 * 3. write `ai.account_profile` — features and 168 UTC active hours;
 * 4. replace its v1 predictions (F-038-d), each with its reasons.
 *
 * Then run the decision pipeline over the predictions just written
 * (F-038-e). A decision run that fails is logged; the profiles it read stay
 * written.
 *
 * Before any of it, for every tenant, its engine on or off: retention
 * (F-038-s, point 14) — readings past 180 days, and every row of an account
 * identity deleted.
 *
 * In the platform owner's run, its resellers too (F-038-o1, ADR-0109 point
 * 4): each is the platform's customer, subject `tenant` — its quota run-out
 * and churn risk, written in the platform's tenant.
 *
 * **Safe to run twice** (ADR-0027): a reading is keyed by its UTC hour, and a
 * second sample in the same hour adds only what grew since the first; a
 * profile is an upsert of the same pure function of the same rows.
 *
 * A tenant that fails is logged and counted, never stops the others: one
 * reseller's bad row must not cost every other reseller its hour.
 */
@Injectable()
export class ProfileBuilder {
  private readonly logger = new Logger(ProfileBuilder.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly reader: ProfileReader,
    private readonly policy: AiTenantPolicy,
    private readonly decisions: DecisionRun,
    private readonly outcomes: OutcomeRun,
    private readonly resellerReader: ResellerReader,
    private readonly resellerDecisions: ResellerDecisionRun,
    private readonly retention: Retention,
  ) {}

  async rebuildAll(now: Date = new Date()): Promise<RebuildResult> {
    // `tenant.tenant` has no RLS; the app pool lists it as every service does.
    const tenants = await this.prisma.tenant.findMany({ select: { id: true, tenantType: true }, orderBy: { id: 'asc' } });
    const result: RebuildResult = { tenants: 0, skipped: 0, accounts: 0, readings: 0, predictions: 0, purged: 0, erased: 0, scheduled: 0, stopped: 0, converted: 0, resellers: 0 };
    for (const { id, tenantType } of tenants) {
      try {
        // F-038-s: an engine switched off is no reason to keep what point 14 erases.
        const kept = await this.retention.runTenant(id, now);
        result.purged += kept.purged;
        result.erased += kept.erased;
      } catch (err) {
        this.logger.error(`retention for tenant ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      let mode: AiTenantMode;
      try {
        mode = await this.policy.forTenant(id);
        if (!mode.engineRuns) {
          result.skipped += 1;
          continue;
        }
        const done = await runWithTenant({ id }, () => this.rebuildTenant(id, now));
        result.tenants += 1;
        result.accounts += done.accounts;
        result.readings += done.readings;
        result.predictions += done.predictions;
      } catch (err) {
        result.skipped += 1;
        this.logger.error(`profile rebuild for tenant ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (tenantType === 'platform_owner') {
        try {
          const resold = await this.rebuildResellers(id, now);
          result.resellers += resold.resellers;
          result.predictions += resold.predictions;
          // F-038-o4: the upgrades those predictions call for, through the same pipeline.
          const decided = await this.resellerDecisions.runPlatform(id, mode, now);
          result.scheduled += decided.scheduled;
          result.stopped += decided.stopped;
          // F-038-o5: and what the resellers did about the earlier ones.
          result.converted += (await this.outcomes.recordResellers(id, now)).converted;
        } catch (err) {
          this.logger.error(`reseller predictions or decisions failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      try {
        const decided = await this.decisions.runTenant(id, mode, now);
        result.scheduled += decided.scheduled;
        result.stopped += decided.stopped;
      } catch (err) {
        this.logger.error(`decision run for tenant ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        // F-038-i: after the decisions, so a purchase this hour also stops what was just queued.
        result.converted += (await this.outcomes.recordTenant(id, now)).converted;
      } catch (err) {
        this.logger.error(`outcome run for tenant ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.logger.log(`profiles: ${result.accounts} account(s) in ${result.tenants} tenant(s), ${result.readings} reading(s), ${result.predictions} prediction(s) (${result.resellers} reseller(s) read), ${result.skipped} skipped, ${result.purged} reading(s) purged, ${result.erased} deleted account(s) erased; ${result.scheduled} suggestion(s) scheduled, ${result.stopped} stopped, ${result.converted} converted`);
    return result;
  }

  /** One tenant, in its scope. */
  async rebuildTenant(tenantId: string, now: Date): Promise<{ accounts: number; readings: number; predictions: number }> {
    const since = new Date(now.getTime() - PROFILE_HISTORY_DAYS * DAY_MS);
    const hour = utcHour(now);
    let accounts = 0;
    let readings = 0;
    let predicted = 0;
    let cursor: string | null = null;
    for (;;) {
      const page = await this.reader.accounts(cursor, PROFILE_PAGE);
      if (page.length === 0) break;
      const userIds = page.map((a) => a.id);

      const counters = await this.reader.counters(userIds);
      readings += await this.sample(tenantId, userIds, counters, hour);
      const inputs = await this.reader.inputs(userIds, since);
      const variantIds = [...new Set([...inputs.values()].flatMap((i) => i.grants.map((g) => g.variantId).filter((v): v is string => v !== null)))];
      const money = await this.reader.money(variantIds, now);

      await tenantTransaction(
        this.prisma,
        async (tx) => {
          const history = await tx.aiMeterReading.findMany({
            where: { tenantId, userId: { in: userIds }, hour: { gt: since } },
            select: { userId: true, grantId: true, meterKey: true, hour: true, delta: true },
          });
          const byUser = new Map<string, AccountInputs['readings']>();
          for (const { userId, ...r } of history) {
            const list = byUser.get(userId) ?? [];
            list.push(r);
            byUser.set(userId, list);
          }

          const forecasts: Array<{ userId: string; p: PredictionRow }> = [];
          const rows = page.map((a) => {
            const account: AccountInputs = { userId: a.id, createdAt: a.createdAt, readings: byUser.get(a.id) ?? [], ...(inputs.get(a.id) as ReaderInputs) };
            const profile = accountFeatures(account, now);
            for (const p of predictions(account, money, now)) forecasts.push({ userId: a.id, p });
            return Prisma.sql`(${tenantId}::uuid, 'user'::"ai"."AiSubjectKind", ${a.id}::uuid, ${JSON.stringify(profile.features)}::jsonb, ${profile.activeHours}::double precision[], ${now})`;
          });
          await tx.$executeRaw`
            INSERT INTO ai.account_profile ("tenantId", "subjectKind", "subjectId", "features", "activeHours", "builtAt")
            VALUES ${Prisma.join(rows)}
            ON CONFLICT ("tenantId", "subjectKind", "subjectId")
            DO UPDATE SET "features" = EXCLUDED."features", "activeHours" = EXCLUDED."activeHours", "builtAt" = EXCLUDED."builtAt"`;

          // Rebuilt, not appended: an account has at most one row of each v1 kind, the latest.
          await tx.aiPrediction.deleteMany({ where: { tenantId, subjectKind: 'user', subjectId: { in: userIds }, kind: { in: [...V1_KINDS] } } });
          if (forecasts.length > 0) {
            await tx.aiPrediction.createMany({
              data: forecasts.map(({ userId, p }) => ({
                tenantId,
                subjectKind: 'user' as const,
                subjectId: userId,
                kind: p.kind,
                value: p.value,
                predictedAt: p.predictedAt,
                currencyCode: p.currencyCode,
                confidence: new Prisma.Decimal(p.confidence.toFixed(4)),
                reasons: p.reasons,
                computedAt: now,
              })),
            });
          }
          predicted += forecasts.length;
        },
        { timeout: WRITE_TIMEOUT_MS },
      );

      accounts += page.length;
      if (page.length < PROFILE_PAGE) break;
      cursor = page[page.length - 1].id;
    }

    return { accounts, readings, predictions: predicted };
  }

  /**
   * The platform's resellers (F-038-o1). Read one by one, each in its own
   * scope; one whose read fails is logged and left without a prediction this
   * hour — never guessed. Then every reseller row of the two kinds is
   * replaced at once, so a reseller gone or no longer at risk keeps none.
   */
  async rebuildResellers(platformTenantId: string, now: Date): Promise<{ resellers: number; predictions: number }> {
    const rows: Array<{ subjectId: string; p: PredictionRow }> = [];
    const resellers = await this.resellerReader.resellers(platformTenantId);
    for (const r of resellers) {
      try {
        for (const p of resellerPredictions(await this.resellerReader.inputs(r, now), now)) rows.push({ subjectId: r.tenantId, p });
        // F-1525-a: the billing wallet at its wholesale rate.
        const wallet = await this.resellerReader.wholesale(r.tenantId);
        const runOut = wallet && walletRunOut(wallet, now);
        const need = runOut && walletNeedPrediction(runOut, now);
        if (need) rows.push({ subjectId: r.tenantId, p: need });
      } catch (err) {
        this.logger.error(`reseller ${r.tenantId} not predicted: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await runWithTenant({ id: platformTenantId }, () =>
      tenantTransaction(
        this.prisma,
        async (tx) => {
          await tx.aiPrediction.deleteMany({ where: { tenantId: platformTenantId, subjectKind: 'tenant', kind: { in: [...RESELLER_KINDS] } } });
          if (rows.length === 0) return;
          await tx.aiPrediction.createMany({
            data: rows.map(({ subjectId, p }) => ({
              tenantId: platformTenantId,
              subjectKind: 'tenant' as const,
              subjectId,
              kind: p.kind,
              value: p.value,
              predictedAt: p.predictedAt,
              currencyCode: p.currencyCode,
              confidence: new Prisma.Decimal(p.confidence.toFixed(4)),
              reasons: p.reasons,
              computedAt: now,
            })),
          });
        },
        { timeout: WRITE_TIMEOUT_MS },
      ),
    );
    return { resellers: resellers.length, predictions: rows.length };
  }

  /**
   * This hour's readings for one page. The last counter per meter is the
   * newest row's; a second run in the same hour adds its growth to that
   * hour's row rather than writing a second one.
   */
  private async sample(tenantId: string, userIds: string[], counters: Awaited<ReturnType<ProfileReader['counters']>>, hour: Date): Promise<number> {
    if (counters.length === 0) return 0;
    return tenantTransaction(
      this.prisma,
      async (tx) => {
        const last = await tx.$queryRaw<Array<{ grantId: string; meterKey: string; counter: bigint }>>`
          SELECT DISTINCT ON ("grantId", "meterKey") "grantId", "meterKey", "counter"
          FROM ai.meter_reading
          WHERE "tenantId" = ${tenantId}::uuid AND "userId" = ANY(ARRAY[${Prisma.join(userIds)}]::uuid[])
          ORDER BY "grantId", "meterKey", "hour" DESC`;
        const rows: MeterReadingRow[] = readingsFor(counters, new Map(last.map((r) => [meterRef(r.grantId, r.meterKey), r.counter])), hour);
        if (rows.length === 0) return 0;
        await tx.$executeRaw`
          INSERT INTO ai.meter_reading ("tenantId", "userId", "grantId", "meterKey", "hour", "counter", "delta")
          VALUES ${Prisma.join(rows.map((r) => Prisma.sql`(${tenantId}::uuid, ${r.userId}::uuid, ${r.grantId}::uuid, ${r.meterKey}, ${r.hour}, ${r.counter}, ${r.delta})`))}
          ON CONFLICT ("tenantId", "grantId", "meterKey", "hour")
          DO UPDATE SET "counter" = EXCLUDED."counter", "delta" = ai.meter_reading."delta" + EXCLUDED."delta"`;
        return rows.length;
      },
      { timeout: WRITE_TIMEOUT_MS },
    );
  }
}
