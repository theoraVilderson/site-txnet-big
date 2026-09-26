import { Prisma } from '@prisma/client';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { SystemsRefused } from './systems-read';

/** The panel that already holds an address, named so the owner can edit or restore it instead. */
export type AddressHolder = { id: string; name: string };

export class PanelAlreadyRegistered extends SystemsRefused {
  constructor(readonly panel: AddressHolder) {
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
 * two rows is the fault whoever registered them.
 */
async function holderOf(all: CrossTenantPrismaService, apiBaseUrl: string, exceptId: string | null): Promise<AddressHolder | undefined> {
  const [holder] = await all.$queryRaw<AddressHolder[]>`SELECT "id", "name" FROM "network"."panel"
     WHERE "apiBaseUrl" IS NOT NULL
       AND "network"."panel_api_address"("apiBaseUrl") = "network"."panel_api_address"(${apiBaseUrl})
       AND "id" IS DISTINCT FROM ${exceptId}::uuid
     LIMIT 1`;
  return holder;
}

/**
 * Run a write that sets `apiBaseUrl`, refused with {@link PanelAlreadyRegistered}
 * when another panel holds the address. The look-up answers the common case;
 * two writes racing past it are settled by the index, and the loser is looked
 * up again so it gets the same refusal rather than a 500.
 */
export async function claimingAddress<T>(
  all: CrossTenantPrismaService,
  apiBaseUrl: string | null | undefined,
  exceptId: string | null,
  write: () => Promise<T>,
): Promise<T> {
  if (!apiBaseUrl) return write();
  const holder = await holderOf(all, apiBaseUrl, exceptId);
  if (holder) throw new PanelAlreadyRegistered(holder);
  try {
    return await write();
  } catch (e) {
    if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    const winner = await holderOf(all, apiBaseUrl, exceptId);
    if (winner) throw new PanelAlreadyRegistered(winner);
    throw e;
  }
}
