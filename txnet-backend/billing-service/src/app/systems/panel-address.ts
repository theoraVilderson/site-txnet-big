import { Prisma } from '@prisma/client';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { inScope, PanelScope } from './panel-scope';
import { SystemsRefused } from './systems-read';

/** The panel that already holds an address, named so the owner can edit or restore it instead. */
export type AddressHolder = { id: string; name: string };

type HolderRow = AddressHolder & { ownershipType: string; tenantId: string | null };

/** `panel` is null when the holder is not the actor's to see: the address is still taken. */
export class PanelAlreadyRegistered extends SystemsRefused {
  constructor(readonly panel: AddressHolder | null) {
    super('panel_already_registered');
  }
}

/**
 * A panel is registered once (F-027-cd, ADR-0090 decision 1): no two panels
 * share a normalised `apiBaseUrl`. The normaliser is SQL
 * (`network.panel_api_address`, migration 20260926001100) and so is the
 * guarantee — the unique index `panel_api_address_key` over it. This look-up
 * goes through the same function, so there is one spelling of "the same
 * address", and it only exists to name the holder.
 *
 * Every panel counts, archived ones and every owner's: the same server under
 * two rows is the fault whoever registered them. Only the naming is scoped.
 */
async function holderOf(all: CrossTenantPrismaService, apiBaseUrl: string, exceptId: string | null): Promise<HolderRow | undefined> {
  const [holder] = await all.$queryRaw<HolderRow[]>`SELECT "id", "name", "ownershipType"::text AS "ownershipType", "tenantId" FROM "network"."panel"
     WHERE "apiBaseUrl" IS NOT NULL
       AND "network"."panel_api_address"("apiBaseUrl") = "network"."panel_api_address"(${apiBaseUrl})
       AND "id" IS DISTINCT FROM ${exceptId}::uuid
     LIMIT 1`;
  return holder;
}

/**
 * A push panel's `ipAddress` is registered once (F-027-ff, ADR-0130 decision
 * 5): two push panels at one IP drop each other off the RADIUS allowlist,
 * across tenants. Normalised by `network.panel_push_address` (migration
 * 20261014000500), the spelling Go's allowlist keys by; held by
 * `panel_push_address_key`. Unlike an API address, only non-retired push
 * panels count — the allowlist reads no archived one — so a clash shows on
 * restore.
 */
async function pushHolderOf(all: CrossTenantPrismaService, ipAddress: string, exceptId: string | null): Promise<HolderRow | undefined> {
  const [holder] = await all.$queryRaw<HolderRow[]>`SELECT "id", "name", "ownershipType"::text AS "ownershipType", "tenantId" FROM "network"."panel"
     WHERE "transport" = 'push' AND "retiredAt" IS NULL AND "ipAddress" IS NOT NULL
       AND "network"."panel_push_address"("ipAddress") = "network"."panel_push_address"(${ipAddress})
       AND "id" IS DISTINCT FROM ${exceptId}::uuid
     LIMIT 1`;
  return holder;
}

/**
 * Run a write, refused with {@link PanelAlreadyRegistered} when `holder` finds
 * another panel — named only inside `scope`. The look-up answers the common
 * case; two writes racing past it are settled by the index, and the loser is
 * looked up again so it gets the same refusal rather than a 500.
 */
async function claiming<T>(scope: PanelScope, holder: () => Promise<HolderRow | undefined>, write: () => Promise<T>): Promise<T> {
  const held = await holder();
  if (held) throw refusal(scope, held);
  try {
    return await write();
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    const winner = await holder();
    if (winner) throw refusal(scope, winner);
    throw e;
  }
}

/** Run a write that sets `apiBaseUrl`, refused while another panel holds the address (F-027-cd). */
export function claimingAddress<T>(
  all: CrossTenantPrismaService,
  scope: PanelScope,
  apiBaseUrl: string | null | undefined,
  exceptId: string | null,
  write: () => Promise<T>,
): Promise<T> {
  if (!apiBaseUrl) return write();
  return claiming(scope, () => holderOf(all, apiBaseUrl, exceptId), write);
}

/** Run a write that gives a live push panel `ipAddress`, refused while another one holds it (F-027-ff). */
export function claimingPushAddress<T>(
  all: CrossTenantPrismaService,
  scope: PanelScope,
  ipAddress: string | null | undefined,
  exceptId: string | null,
  write: () => Promise<T>,
): Promise<T> {
  if (!ipAddress) return write();
  return claiming(scope, () => pushHolderOf(all, ipAddress, exceptId), write);
}

function refusal(scope: PanelScope, { id, name, ...owner }: HolderRow): PanelAlreadyRegistered {
  return new PanelAlreadyRegistered(inScope(scope, owner) ? { id, name } : null);
}
