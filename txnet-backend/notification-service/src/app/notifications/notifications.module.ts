import { Module } from '@nestjs/common';

import { GrantNoticeLevelController } from './grant-notice-level.controller';
import { GrantNoticeLevelService } from './grant-notice-level.service';
import { NotificationInboxController } from './notification-inbox.controller';
import { NotificationInboxService } from './notification-inbox.service';
import { NotificationInternalController } from './notification-internal.controller';
import { NotificationPreferencesController } from './notification-preferences.controller';
import { NotificationPreferencesService } from './notification-preferences.service';
import { RetentionLedgerService } from './retention-ledger.service';

/** A user's in-app notifications (F-035-a), the retention ledger (F-601-a) and its preferences (F-601-m, per Grant F-601-o). Campaigns are `campaigns/` (F-035-c). */
@Module({
  controllers: [NotificationInboxController, NotificationPreferencesController, GrantNoticeLevelController, NotificationInternalController],
  providers: [NotificationInboxService, NotificationPreferencesService, GrantNoticeLevelService, RetentionLedgerService],
})
export class NotificationsModule {}
