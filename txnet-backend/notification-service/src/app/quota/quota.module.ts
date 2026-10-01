import { Module } from '@nestjs/common';

import { QuotaDigestService } from './quota-digest.service';
import { QuotaInternalController } from './quota-internal.controller';

/** A reseller told about its quotas (F-019-v8): the daily digest. The alerts at 80% / 100% are the engine's, at the act. */
@Module({
  controllers: [QuotaInternalController],
  providers: [QuotaDigestService],
})
export class QuotaModule {}
