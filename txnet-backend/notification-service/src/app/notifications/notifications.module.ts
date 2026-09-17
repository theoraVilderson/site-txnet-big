import { Module } from '@nestjs/common';

import { NotificationInboxController } from './notification-inbox.controller';
import { NotificationInboxService } from './notification-inbox.service';
import { NotificationInternalController } from './notification-internal.controller';

/** A user's in-app notifications (F-035-a). Campaigns are `campaigns/` (F-035-c). */
@Module({
  controllers: [NotificationInboxController, NotificationInternalController],
  providers: [NotificationInboxService],
})
export class NotificationsModule {}
