import { Module } from '@nestjs/common';

import { SupportRealtime } from '../realtime/support-realtime';
import { SupportLifecycle } from './lifecycle';
import { SupportLifecycleController, SupportLifecycleInternalController, SupportLifecycleSettingsController } from './lifecycle.controller';

/** Auto-close, rating and reopen (F-033-k). */
@Module({
  controllers: [SupportLifecycleController, SupportLifecycleSettingsController, SupportLifecycleInternalController],
  providers: [SupportLifecycle, SupportRealtime],
})
export class SupportLifecycleModule {}
