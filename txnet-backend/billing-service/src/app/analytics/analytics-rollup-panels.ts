import { Prisma } from '@prisma/client';

import type { CrossTenantReader } from './analytics-context';
import { Day, addDays } from './analytics-days';
import type { RollupRange } from './analytics-rollup';

/**
 * The capacity rollup (F-1005-a, contract.analytics-tabs.md "Capacity"):
 * `analytics_panel_traffic_day` and `analytics_panel_clients_day`, on the
 * rollup of the panel's **owner** — the platform's panels on the platform's,
 * a reseller's own on its own. A panel is full of every tenant's users, so
 * the reads go through `across` (a reseller's configs are its own); every
 * write is scoped by `public.current_tenant_id()`. Days are UTC dates, as
 * the network's daily aggregate and a panel's price are cut.
 */

export type PanelRollup = { tenantId: string; platform: boolean; across: CrossTenantReader };

/** The panels a tenant owns: the platform's own kind for the platform, its own for a reseller. */
const owned = (how: PanelRollup) =>
  how.platform ? Prisma.sql`p."ownershipType" = 'platform'` : Prisma.sql`p."ownershipType" = 'tenant' AND p."tenantId" = ${how.tenantId}::uuid`;

/** Each owned panel's traffic on every UTC date of `r`, every tenant's users summed. */
export async function writePanelTraffic(tx: Prisma.TransactionClient, r: RollupRange, how: PanelRollup): Promise<void> {
  await tx.$executeRaw`DELETE FROM billing.analytics_panel_traffic_day WHERE "tenantId" = public.current_tenant_id() AND "day" BETWEEN ${r.fromDay}::date AND ${r.toDay}::date`;
  const rows = await how.across.$queryRaw<{ day: Day; panelId: string; bytes: bigint }[]>`
    SELECT to_char(t."date", 'YYYY-MM-DD') AS "day", c."panelId", SUM(t."totalUploadBytes" + t."totalDownloadBytes")::bigint AS "bytes"
    FROM network.traffic_daily_aggregate t
    JOIN network.config c ON c."id" = t."configId"
    JOIN network.panel p ON p."id" = c."panelId" AND ${owned(how)}
    WHERE t."date" BETWEEN ${r.fromDay}::date AND ${r.toDay}::date
    GROUP BY 1, 2`;
  if (rows.length === 0) return;
  await tx.$executeRaw`
    INSERT INTO billing.analytics_panel_traffic_day ("tenantId", "day", "panelId", "bytes")
    SELECT public.current_tenant_id(), x."day", x."panelId", x."bytes"
    FROM unnest(${rows.map((x) => x.day)}::date[], ${rows.map((x) => x.panelId)}::uuid[], ${rows.map((x) => x.bytes.toString())}::bigint[]) AS x("day", "panelId", "bytes")`;
}

/**
 * `utcToday`'s snapshot: per owned panel in service, the Grants with a live
 * (not retired) config on it — what `maxClients` caps. A panel with none
 * stands at 0, so its growth is read from the day it opened.
 */
export async function writePanelClientsToday(tx: Prisma.TransactionClient, utcToday: Day, how: PanelRollup): Promise<void> {
  await tx.$executeRaw`DELETE FROM billing.analytics_panel_clients_day WHERE "tenantId" = public.current_tenant_id() AND "day" = ${utcToday}::date`;
  const rows = await how.across.$queryRaw<{ panelId: string; clients: number }[]>`
    SELECT p."id" AS "panelId", COUNT(DISTINCT c."grantId")::int AS "clients"
    FROM network.panel p
    LEFT JOIN network.config c ON c."panelId" = p."id" AND c."status" <> 'retired'
    WHERE ${owned(how)} AND p."retiredAt" IS NULL
    GROUP BY p."id"`;
  if (rows.length === 0) return;
  await tx.$executeRaw`
    INSERT INTO billing.analytics_panel_clients_day ("tenantId", "day", "panelId", "clients")
    SELECT public.current_tenant_id(), ${utcToday}::date, x."panelId", x."clients"
    FROM unnest(${rows.map((x) => x.panelId)}::uuid[], ${rows.map((x) => x.clients)}::int[]) AS x("panelId", "clients")`;
}

/**
 * A digest of both tables over `r` and the day after — a UTC date can run a
 * day ahead of the tenant's — so a pass that moved only a panel figure still
 * says the rollup changed.
 */
export async function panelsFingerprint(tx: Prisma.TransactionClient, r: RollupRange): Promise<string> {
  const to = addDays(r.toDay, 1);
  const [row] = await tx.$queryRaw<{ digest: string }[]>`
    SELECT md5(COALESCE(string_agg(x, '|' ORDER BY x), '')) AS "digest" FROM (
      SELECT 't' || row(t."day", t."panelId", t."bytes")::text AS x
        FROM billing.analytics_panel_traffic_day t WHERE t."tenantId" = public.current_tenant_id() AND t."day" BETWEEN ${r.fromDay}::date AND ${to}::date
      UNION ALL
      SELECT 'c' || row(c."day", c."panelId", c."clients")::text
        FROM billing.analytics_panel_clients_day c WHERE c."tenantId" = public.current_tenant_id() AND c."day" BETWEEN ${r.fromDay}::date AND ${to}::date
    ) q`;
  return row?.digest ?? '';
}
