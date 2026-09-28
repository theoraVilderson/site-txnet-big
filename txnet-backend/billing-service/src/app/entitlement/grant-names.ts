import { Injectable } from '@nestjs/common';
import { ConfigStatus } from '@prisma/client';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';
import { z } from 'zod';

import { PrismaService } from '../prisma/prisma.service';

/** A combined notice lists at most a burst's services; a burst of more is told without names past this. */
const MAX_GRANTS = 500;

export const grantNamesSchema = z
  .object({
    tenantId: z.string().uuid(),
    userId: z.string().uuid(),
    grantIds: z.array(z.string().uuid()).min(1).max(MAX_GRANTS),
  })
  .strict();
export type GrantNamesBody = z.infer<typeof grantNamesSchema>;

/**
 * One service as a notice names it (F-601-p): the buyer's own name for it
 * (F-307-x), listed first; the catalog name key and sku My
 * services shows it by (the variant's own wording, else its product's), and
 * the buyer's labels on its live configs (F-307-f) — what tells five
 * identical purchases apart. `null`s: a Grant issued without a catalog item.
 */
export type GrantName = { grantId: string; label: string | null; nameKey: string | null; sku: string | null; labels: string[] };

/**
 * The names a combined retention notice lists (F-601-p, notification
 * `contract.retention.md` "Several services, one message"), for
 * `worker-service` on the internal seam. It returns keys, never text: the
 * words are auth-service's, in the user's language.
 *
 * **Scoped, not cross-tenant.** The caller knows the notice's tenant and
 * user, so the read runs in that tenant's transaction and only the user's
 * own Grants answer; an id of another user's Grant is simply not in the list.
 */
@Injectable()
export class GrantNamesService {
  constructor(private readonly prisma: PrismaService) {}

  names({ tenantId, userId, grantIds }: GrantNamesBody): Promise<GrantName[]> {
    return runWithTenant({ id: tenantId }, () =>
      tenantTransaction(this.prisma, async (tx) => {
        const grants = await tx.grant.findMany({
          where: { id: { in: grantIds }, userId },
          select: { id: true, userLabel: true, variant: { select: { sku: true, nameKey: true, product: { select: { nameKey: true } } } } },
        });
        const configs = await tx.config.findMany({
          where: { grantId: { in: grants.map((g) => g.id) }, userId, status: { not: ConfigStatus.retired }, userLabel: { not: null } },
          select: { grantId: true, userLabel: true },
          orderBy: { createdAt: 'asc' },
        });
        return grants.map((g) => ({
          grantId: g.id,
          label: g.userLabel,
          nameKey: g.variant ? (g.variant.nameKey ?? g.variant.product.nameKey) : null,
          sku: g.variant?.sku ?? null,
          labels: [...new Set(configs.filter((c) => c.grantId === g.id).map((c) => c.userLabel!))],
        }));
      }),
    );
  }
}
