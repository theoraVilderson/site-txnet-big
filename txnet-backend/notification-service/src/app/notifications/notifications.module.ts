import { Module } from '@nestjs/common';

import { NotificationInboxController } from './notification-inbox.controller';
import { NotificationInboxService } from './notification-inbox.service';
import { NotificationInternalController } from './notification-internal.controller';
import { RetentionLedgerService } from './retention-ledger.service';

/** A user's in-app notifications (F-035-a) and the retention ledger (F-601-a). Campaigns are `campaigns/` (F-035-c). */
@Module({
  controllers: [NotificationInboxController, NotificationInternalController],
  providers: [NotificationInboxService, RetentionLedgerService],
})
export class NotificationsModule {}
