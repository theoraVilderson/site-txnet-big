import type { UserSignedUpPayload } from '@txnet-backend/shared-core';
import { runWithTenant, tenantTransaction } from '@txnet-backend/shared-core';

import type { PrismaService } from '../prisma/prisma.service';

/**
 * A signup, recorded for analytics (F-1001-f, billing/contract.analytics.md
 * "Rollup tables"): one `analytics_signup` row per user, in the user's tenant.
 * The relay is at-least-once; a second copy finds the row and writes nothing.
 */
export async function recordSignup(prisma: PrismaService, signup: UserSignedUpPayload): Promise<void> {
  await runWithTenant({ id: signup.tenantId }, async () => {
    await tenantTransaction(prisma, (tx) =>
      tx.analyticsSignup.createMany({
        data: [{ userId: signup.userId, tenantId: signup.tenantId, signedUpAt: new Date(signup.signedUpAt), source: signup.source }],
        skipDuplicates: true,
      }),
    );
  });
}
