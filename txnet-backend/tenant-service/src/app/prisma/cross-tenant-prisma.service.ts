import { Injectable } from '@nestjs/common';

import { PrismaService } from './prisma.service';

/**
 * The second pool: every tenant's rows, by policy (ADR-0053's shape).
 *
 * Reseller administration is the platform owner's, over tenants that are not
 * the caller's own, so it cannot run on the app pool's tenant binding. It
 * connects as `DATABASE_CROSS_TENANT_URL` (`txnet_cross_tenant_user`, no
 * `BYPASSRLS`) and is not extended with `withTenant`.
 *
 * **Injecting it is the audit.** No class injects it yet (F-018-t has no
 * business routes); each one that does, from F-018-u on, says in a doc comment
 * where it decides the caller is the platform owner.
 */
@Injectable()
export class CrossTenantPrismaService extends PrismaService {}
