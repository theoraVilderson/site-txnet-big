import type { Request } from 'express';

import { identityOf } from '../request/identity.middleware';
import { CatalogActor, CatalogAdminRefused } from './catalog-admin.service';
import { CATALOG_REFUSAL_STATUS, catalogRefusal } from './catalog-refusal';
import { STATUS as RESELLER_STATUS } from './reseller-catalog.controller';
import { ResellerCatalogActor, ResellerCatalogRefused } from './reseller-catalog.service';

/**
 * What a controller over the catalog's two doors shares (F-1002-d, F-305-b):
 * who is asking, as the gate proved them, and a refusal turned into its status.
 * The ambient door and the one that names a reseller (ADR-0064) answer alike.
 */

/** The caller on the ambient door (`/api/catalog`). */
export function catalogActorOf(req: Request, ip: string): CatalogActor {
  const { userId, tenantId, permissions } = identityOf(req);
  return { adminId: userId, tenantId, ip, permissions };
}

/** The caller on the reseller's door; the reseller is the path's. */
export function resellerCatalogActorOf(req: Request, ip: string): ResellerCatalogActor {
  const { userId, tenantId, permissions } = identityOf(req);
  return { userId, tenantId, permissions, ip };
}

/** `run`, with a catalog refusal answered by its status. */
export async function refusingCatalog<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof CatalogAdminRefused)) throw e;
    throw catalogRefusal(CATALOG_REFUSAL_STATUS[e.reason], e.reason, e.message);
  }
}

/** `run`, with a refusal on the reseller's door — its own reasons and the catalog's — answered by its status. */
export async function refusingResellerCatalog<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!(e instanceof ResellerCatalogRefused)) throw e;
    throw catalogRefusal(RESELLER_STATUS[e.reason], e.reason, e.message);
  }
}
