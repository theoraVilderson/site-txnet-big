import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import { AiTenantPolicy } from '../policy/ai-tenant-policy';
import { PrismaService } from '../prisma/prisma.service';
import { meterRef, readingsFor, utcHour, type MeterReadingRow } from './meter-readings';
import { accountFeatures, PROFILE_HISTORY_DAYS, type AccountInputs } from './profile-features';
import { ProfileReader, type ReaderInputs } from './profile-reader';

const DAY_MS = 86_400_000;
/** Accounts per page: one reader transaction and one writer transaction each, bounded memory on a 512 MB container. */
const PROFILE_PAGE = 500;
const WRITE_TIMEOUT_MS = 30_000;

export type RebuildResult = { tenants: number; skipped: number; accounts: number; readings: number; purged: number };

/**
 * The hourly profile rebuild (F-038-c, ADR-0109 points 6, 7, 14). For every
 * tenant whose engine runs (F-1550, F-038-x — `AiTenantPolicy`, the same rule
 * a trigger obeys), page by page over its accounts:
 *
 * 1. sample each active Grant's meters into `ai.meter_reading`;
 * 2. read 180 days of the account's inputs through the reader;
 * 3. write `ai.account_profile` — features and 168 UTC active hours.
 *
 * Then drop that tenant's readings older than 180 days (point 14).
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
  ) {}

  async rebuildAll(now: Date = new Date()): Promise<RebuildResult> {
    // `tenant.tenant` has no RLS; the app pool lists it as every service does.
    const tenants = await this.prisma.tenant.findMany({ select: { id: true }, orderBy: { id: 'asc' } });
    const result: RebuildResult = { tenants: 0, skipped: 0, accounts: 0, readings: 0, purged: 0 };
    for (const { id } of tenants) {
      try {
        const mode = await this.policy.forTenant(id);
        if (!mode.engineRuns) {
          result.skipped += 1;
          continue;
        }
        const done = await runWithTenant({ id }, () => this.rebuildTenant(id, now));
        result.tenants += 1;
        result.accounts += done.accounts;
        result.readings += done.readings;
        result.purged += done.purged;
      } catch (err) {
        result.skipped += 1;
        this.logger.error(`profile rebuild for tenant ${id} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.logger.log(`profiles: ${result.accounts} account(s) in ${result.tenants} tenant(s), ${result.readings} reading(s), ${result.skipped} skipped`);
    return result;
  }

  /** One tenant, in its scope. */
  async rebuildTenant(tenantId: string, now: Date): Promise<{ accounts: number; readings: number; purged: number }> {
    const since = new Date(now.getTime() - PROFILE_HISTORY_DAYS * DAY_MS);
    const hour = utcHour(now);
    let accounts = 0;
    let readings = 0;
    let cursor: string | null = null;
    for (;;) {
      const page = await this.reader.accounts(cursor, PROFILE_PAGE);
      if (page.length === 0) break;
      const userIds = page.map((a) => a.id);

      const counters = await this.reader.counters(userIds);
      readings += await this.sample(tenantId, userIds, counters, hour);
      const inputs = await this.reader.inputs(userIds, since);

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

          const rows = page.map((a) => {
            const account: AccountInputs = { userId: a.id, createdAt: a.createdAt, readings: byUser.get(a.id) ?? [], ...(inputs.get(a.id) as ReaderInputs) };
            const profile = accountFeatures(account, now);
            return Prisma.sql`(${tenantId}::uuid, 'user'::"ai"."AiSubjectKind", ${a.id}::uuid, ${JSON.stringify(profile.features)}::jsonb, ${profile.activeHours}::double precision[], ${now})`;
          });
          await tx.$executeRaw`
            INSERT INTO ai.account_profile ("tenantId", "subjectKind", "subjectId", "features", "activeHours", "builtAt")
            VALUES ${Prisma.join(rows)}
            ON CONFLICT ("tenantId", "subjectKind", "subjectId")
            DO UPDATE SET "features" = EXCLUDED."features", "activeHours" = EXCLUDED."activeHours", "builtAt" = EXCLUDED."builtAt"`;
        },
        { timeout: WRITE_TIMEOUT_MS },
      );

      accounts += page.length;
      if (page.length < PROFILE_PAGE) break;
      cursor = page[page.length - 1].id;
    }

    const purged = await tenantTransaction(this.prisma, (tx) =>
      tx.aiMeterReading.deleteMany({ where: { tenantId, hour: { lt: since } } }),
    );
    return { accounts, readings, purged: purged.count };
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
