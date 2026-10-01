import { Injectable, Logger } from '@nestjs/common';
import { quotaDigests, type QuotaDigestRun } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';

/**
 * The reseller's daily quota digest (F-019-v8, ADR-0107 point 11): yesterday's
 * refused units and overage, told to each reseller's owner from 09:00 on the
 * quota clock, once — the decision is `shared-core` `quotaDigests`. Run by
 * worker-service's `reseller_quota_digest` job every hour.
 *
 * **Why the cross-tenant pool:** the digest is the platform's, over every
 * reseller; nothing in the call names one.
 */
@Injectable()
export class QuotaDigestService {
  private readonly logger = new Logger(QuotaDigestService.name);

  constructor(private readonly all: CrossTenantPrismaService) {}

  async run(now = new Date()): Promise<QuotaDigestRun> {
    const run = await quotaDigests(this.all, now);
    if (run.told > 0) this.logger.log(`quota digest told ${run.told} of ${run.resellers} reseller(s)`);
    return run;
  }
}
