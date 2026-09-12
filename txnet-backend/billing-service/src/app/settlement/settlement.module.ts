import { Module } from '@nestjs/common';

import { SettlementController } from './settlement.controller';
import { SettlementService } from './settlement.service';

/**
 * The operator surface over granted gateways (F-096-e).
 *
 * No imports: `PrismaModule` is `@Global()` and provides both pools, and this
 * module reaches nothing else — no Redis, no locale, no provider registry. That
 * is a property worth keeping. The settlement ledger is read and written by
 * exactly one class, so `grep -rn SettlementService` is the list of everything
 * that can move money's record of itself.
 */
@Module({
  controllers: [SettlementController],
  providers: [SettlementService],
  exports: [SettlementService],
})
export class SettlementModule {}
