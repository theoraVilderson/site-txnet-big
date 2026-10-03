import { Module } from '@nestjs/common';

import { HttpNoticeSeam, SUPPORT_NOTICE_SEAM, SupportNotifier } from './support-notifier';

/** New-message notices through auth-service's inbox seam (F-033-i). */
@Module({
  providers: [SupportNotifier, { provide: SUPPORT_NOTICE_SEAM, useClass: HttpNoticeSeam }],
  exports: [SupportNotifier],
})
export class SupportNotifyModule {}
