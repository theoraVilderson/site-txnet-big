import { createHash } from 'node:crypto';

import { ConfigProtocol, MigrationItemAction, type MigrationItem, type MigrationSkipReason } from '@prisma/client';

import { isUnlimitedClient, LINK_SOURCE, ownSkipOf, remoteIdentityOf, sourceClientSchema, type ImportSource, type SourceClient } from './migration-plan';
import type { PlannedRunItem, RunPlan } from './migration-run-plan';
import type { LinkRead } from './migration-seams';

const MS_PER_SECOND = 1000;

/** A share line's scheme to the protocol we sell; the short forms are what the apps write (`ss://`, `hy2://`, `wg://`). */
const SCHEME_PROTOCOL: Readonly<Record<string, ConfigProtocol>> = {
  ...Object.fromEntries(Object.values(ConfigProtocol).map((p) => [p, p])),
  ss: ConfigProtocol.shadowsocks,
  hy2: ConfigProtocol.hysteria2,
  wg: ConfigProtocol.wireguard,
};

/** The path and query that carry the old token, as `sub-service` compares a path: no trailing slash. */
function tokenPartOf(url: URL): string {
  return `${url.pathname.replace(/\/+$/, '')}${url.search}`;
}

/** A link run's source: `LINK_SOURCE` under the link's origin, so its key is `remoteIdentityOf`'s form. */
export const linkSourceOf = (link: string): ImportSource => ({ family: LINK_SOURCE, sourceAddress: new URL(link).origin });

/** The client's id within its link's source: the sha256 of the path and query, so the old token is in no key or log. */
const linkRemoteIdOf = (link: string): string => createHash('sha256').update(tokenPartOf(new URL(link))).digest('hex');

/**
 * A link run's import key (invariant 32): `link|<origin>|<sha256 of path and
 * query>`. The same link read twice is the same key, so a second request
 * plans an `update`, never a second Grant.
 */
export function linkIdentityOf(link: string): string {
  return remoteIdentityOf(linkSourceOf(link), linkRemoteIdOf(link));
}

/** The protocol of the first line we sell, or '' — a link carrying nothing we sell is `unknown_protocol`. */
function protocolOfLines(lines: readonly string[]): string {
  for (const line of lines) {
    const scheme = /^([a-z0-9+.-]+):\/\//i.exec(line.trim())?.[1]?.toLowerCase();
    const protocol = scheme ? SCHEME_PROTOCOL[scheme] : undefined;
    if (protocol) return protocol;
  }
  return '';
}

/**
 * One old link as the import's client (F-201-g, entitlement
 * `contract.link-import.md`): the header's quota (0 is unlimited, as in every
 * family), usage and end (0 is none), the protocol of its first line we sell,
 * and the link itself as the old link to keep answering (F-203-a). The lines
 * are not kept: they are someone's configs, and the commit places fresh ones.
 */
export function linkClientOf(link: string, read: LinkRead): SourceClient {
  const url = new URL(link);
  const { uploadBytes, downloadBytes, totalBytes, expiresAt } = read.userinfo;
  return sourceClientSchema.parse({
    remoteId: linkRemoteIdOf(link),
    label: url.hostname,
    uuid: '',
    inboundRemoteId: '',
    protocol: protocolOfLines(read.lines),
    enabled: true,
    dataLimitBytes: totalBytes,
    upBytes: uploadBytes,
    downBytes: downloadBytes,
    expiresAt: expiresAt > 0 ? new Date(expiresAt * MS_PER_SECOND).toISOString() : null,
    lines: [],
    linesRead: false,
    subscriptionUrl: link,
  });
}

/** What an admin entered over what the link said; null leaves the read figure. */
export type LinkCorrection = Pick<MigrationItem, 'correctedDataLimitBytes' | 'correctedUsedBytes' | 'correctedExpiresAt'>;

/**
 * The client the plan and the commit go by: the admin's figures laid over the
 * read ones. The snapshot itself is never edited, so what the link claimed
 * stays beside what was approved. A corrected usage is one figure, down.
 */
export function correctedClientOf(client: SourceClient, correction: { dataLimitBytes: bigint | null; usedBytes: bigint | null; expiresAt: Date | null }): SourceClient {
  return {
    ...client,
    ...(correction.dataLimitBytes === null ? {} : { dataLimitBytes: Number(correction.dataLimitBytes) }),
    ...(correction.usedBytes === null ? {} : { upBytes: 0, downBytes: Number(correction.usedBytes) }),
    ...(correction.expiresAt === null ? {} : { expiresAt: correction.expiresAt }),
  };
}

/** A link item's client as the plan and the commit read it: its snapshot, corrected. */
export function linkItemClientOf(item: Pick<MigrationItem, 'sourceSnapshot'> & LinkCorrection): SourceClient {
  return correctedClientOf(sourceClientSchema.parse(item.sourceSnapshot), {
    dataLimitBytes: item.correctedDataLimitBytes,
    usedBytes: item.correctedUsedBytes,
    expiresAt: item.correctedExpiresAt,
  });
}

/** What a link's plan asks of the tenant besides the client. */
export type LinkPlanContext = {
  now: Date;
  /** Whether the chosen product sells unlimited traffic; null while the admin has chosen none. */
  variantUnlimited: boolean | null;
  /** The tenant already holds a Grant of this link's key. */
  held: boolean;
  /** The link's old path already answers for another Grant of the tenant: a panel import brought it (F-203-a). */
  oldLinkTaken: boolean;
};

/** The client as kept on its item: its end as text, as a panel run keeps it. */
const snapshotOf = (c: SourceClient) => ({ ...c, expiresAt: c.expiresAt?.toISOString() ?? null });

/**
 * A link run's report (F-201-g): one item. Skipped for what the client says
 * (`expired`, `unknown_protocol`, `ownSkipOf`), a link a panel import
 * already brought (`duplicate`), or an unlimited claim on a limited product or
 * the reverse (`traffic_mismatch`); an `update` when the tenant holds its
 * Grant already. The person is the run's, so there is no room to forecast.
 * The client is the corrected one; the snapshot written is what was read.
 */
export function planLinkRun(client: SourceClient, remoteIdentity: string, ctx: LinkPlanContext, read: SourceClient = client): RunPlan {
  const item = (plannedAction: MigrationItemAction, skipReason: MigrationSkipReason | null = null): PlannedRunItem => ({ remoteIdentity, sourceSnapshot: snapshotOf(read), plannedAction, skipReason });
  const plan = (planned: PlannedRunItem): RunPlan => ({
    items: [planned],
    plannedCreate: Number(planned.plannedAction === MigrationItemAction.create),
    plannedUpdate: Number(planned.plannedAction === MigrationItemAction.update),
    plannedSkip: Number(planned.plannedAction === MigrationItemAction.skip),
    unaddressed: 0,
  });

  const own = ownSkipOf(client, ctx.now);
  if (own) return plan(item(MigrationItemAction.skip, own));
  if (ctx.held) return plan(item(MigrationItemAction.update));
  if (ctx.oldLinkTaken) return plan(item(MigrationItemAction.skip, 'duplicate'));
  if (ctx.variantUnlimited !== null && isUnlimitedClient(client) !== ctx.variantUnlimited) return plan(item(MigrationItemAction.skip, 'traffic_mismatch'));
  return plan(item(MigrationItemAction.create));
}
