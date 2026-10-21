import { MigrationItemAction, type DriverType, type MigrationSkipReason, type Prisma } from '@prisma/client';

import { planMigrationItem, remoteIdentityOf, sourceClientSchema, type SourceClient } from './migration-plan';

/** What the dry run knows besides the snapshot (F-206): the run's source, the mapping, and what the tenant already holds. */
export type RunPlanContext = {
  family: DriverType;
  sourceAddress: string;
  now: Date;
  /** The variant chosen for each source inbound; every inbound with clients has one before a plan is made. */
  variantOf: ReadonlyMap<string, string>;
  /** `remoteIdentity` of every Grant the tenant already holds from an import: an `update`, never a second Grant (invariant 32). */
  importedGrants: ReadonlySet<string>;
  /** `remoteIdentity` of every person already imported (identity rule 1): they take no room. */
  importedUsers: ReadonlySet<string>;
  /** How many more people the reseller may take (`end_users_max`, F-019-t2); null = no limit. */
  userRoom: number | null;
};

/** One `migration_item` as the dry run writes it. */
export type PlannedRunItem = {
  remoteIdentity: string;
  sourceSnapshot: Prisma.InputJsonValue;
  plannedAction: MigrationItemAction;
  skipReason: MigrationSkipReason | null;
};

/** The report's counts; `unaddressed` are clients with no usable id, counted as skipped but with no row to name them. */
export type RunPlan = { items: PlannedRunItem[]; plannedCreate: number; plannedUpdate: number; plannedSkip: number; unaddressed: number };

const REMOTE_ID_MAX = sourceClientSchema.shape.remoteId.maxLength ?? 0;

/** The source's id of a client, if it has one an item can be keyed by. */
function remoteIdOf(raw: unknown): string | null {
  const id = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)['remoteId'] : undefined;
  return typeof id === 'string' && id.trim() !== '' && id.length <= REMOTE_ID_MAX ? id : null;
}

/** The client as kept on its item: the parsed shape, its end as text — the source state F-211 restores from. */
const snapshotOf = (c: SourceClient): Prisma.InputJsonValue => ({ ...c, expiresAt: c.expiresAt?.toISOString() ?? null });

/** The source inbounds the snapshot's clients sit on, with how many each holds — the ones that need a variant. */
export function clientsPerInbound(clients: readonly unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of clients) {
    const inbound = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)['inboundRemoteId'] : undefined;
    if (typeof inbound === 'string') counts.set(inbound, (counts.get(inbound) ?? 0) + 1);
  }
  return counts;
}

/**
 * The dry run's plan of a whole snapshot (F-206, entitlement
 * `contract.import.md`): one item per source client, in the snapshot's order.
 *
 * - **unreadable** — the client fails `sourceClientSchema` (catalog §16); one
 *   with no id at all has no row and is only counted.
 * - **expired**, **unknown_protocol** — what the client alone says (F-202).
 * - **duplicate** — the same credential (`uuid`) as a client already planned:
 *   one person listed on two inbounds (3x-ui shares a client's uuid), imported once.
 * - **update** — the tenant already holds a Grant of that key.
 * - **over_cap** — a new person past the reseller's room; one already
 *   imported takes none. The commit asks identity again (identity rule 3):
 *   this is the forecast, not the gate.
 *
 * A client the snapshot lists twice is planned once.
 */
export function planRun(clients: readonly unknown[], ctx: RunPlanContext): RunPlan {
  const plan: RunPlan = { items: [], plannedCreate: 0, plannedUpdate: 0, plannedSkip: 0, unaddressed: 0 };
  const seen = new Set<string>();
  const credentials = new Set<string>();
  let newPeople = 0;
  const add = (item: PlannedRunItem) => {
    plan.items.push(item);
    if (item.plannedAction === MigrationItemAction.create) plan.plannedCreate += 1;
    else if (item.plannedAction === MigrationItemAction.update) plan.plannedUpdate += 1;
    else plan.plannedSkip += 1;
  };
  const skip = (remoteIdentity: string, sourceSnapshot: Prisma.InputJsonValue, skipReason: MigrationSkipReason) =>
    add({ remoteIdentity, sourceSnapshot, plannedAction: MigrationItemAction.skip, skipReason });

  for (const raw of clients) {
    const remoteId = remoteIdOf(raw);
    if (remoteId === null) {
      plan.unaddressed += 1;
      plan.plannedSkip += 1;
      continue;
    }
    const remoteIdentity = remoteIdentityOf(ctx, remoteId);
    if (seen.has(remoteIdentity)) continue;
    seen.add(remoteIdentity);

    const parsed = sourceClientSchema.safeParse(raw);
    if (!parsed.success) {
      skip(remoteIdentity, { remoteId }, 'unreadable');
      continue;
    }
    const client = parsed.data;
    const snapshot = snapshotOf(client);
    const variantId = ctx.variantOf.get(client.inboundRemoteId);
    // `previewOf` refuses a plan with an inbound left unmapped; this is the belt to it.
    if (!variantId) throw new Error(`inbound ${client.inboundRemoteId} has no variant`);
    const item = planMigrationItem(client, { family: ctx.family, sourceAddress: ctx.sourceAddress, variantId, now: ctx.now });
    if (item.skipReason) {
      skip(remoteIdentity, snapshot, item.skipReason);
      continue;
    }
    if (client.uuid && credentials.has(client.uuid)) {
      skip(remoteIdentity, snapshot, 'duplicate');
      continue;
    }
    if (client.uuid) credentials.add(client.uuid);
    if (ctx.importedGrants.has(remoteIdentity)) {
      add({ remoteIdentity, sourceSnapshot: snapshot, plannedAction: MigrationItemAction.update, skipReason: null });
      continue;
    }
    const isNewPerson = !ctx.importedUsers.has(remoteIdentity);
    if (isNewPerson && ctx.userRoom !== null && newPeople >= ctx.userRoom) {
      skip(remoteIdentity, snapshot, 'over_cap');
      continue;
    }
    if (isNewPerson) newPeople += 1;
    add({ remoteIdentity, sourceSnapshot: snapshot, plannedAction: MigrationItemAction.create, skipReason: null });
  }
  return plan;
}
