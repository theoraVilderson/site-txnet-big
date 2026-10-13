/**
 * The tenant type and every question the panel asks of it (C-18, FE-1-b).
 * A caller imports the question; a literal compared at a call site is the
 * question asked again, and on 2026-10-13 two copies had already drifted.
 */

/** Prisma's `TenantType`: the platform's own tenant, or a reseller's. */
export type TenantType = "platform_owner" | "reseller";

/** The platform's own tenant type, for data that lists types (a menu entry's `tenantTypes`). */
export const PLATFORM_TENANT_TYPE: TenantType = "platform_owner";

type TenantView = { type: TenantType; isOwner: boolean } | null | undefined;

/** Is this the platform's own tenant, not a reseller's? */
export const isPlatformTenant = (type: TenantType | null | undefined): boolean => type === PLATFORM_TENANT_TYPE;

/** Is this the account that owns the platform? It holds every key (tenant invariant 6). */
export const ownsPlatform = (tenant: TenantView): boolean => isPlatformTenant(tenant?.type) && tenant?.isOwner === true;

/** A user of the platform's tenant other than its owner account — who may buy and hold a reseller (F-019-i). */
export const isPlatformUser = (tenant: TenantView): boolean => isPlatformTenant(tenant?.type) && tenant?.isOwner === false;
