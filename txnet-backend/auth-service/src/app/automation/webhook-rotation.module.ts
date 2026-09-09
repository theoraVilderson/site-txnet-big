import { Module } from '@nestjs/common';
import { MessengerModule } from '@txnet-backend/messenger';
import { AuthModule } from '../auth/auth.module';
import { AutomationModule } from './automation.module';
import { WebhookRotationController } from './webhook-rotation.controller';
import { WebhookRotationService } from './webhook-rotation.service';

/**
 * Webhook path rotation (F-322).
 *
 * A module beside `AutomationModule` rather than inside it, because rotation
 * needs a bot *driver* and `AutomationModule` is what supplies `messenger` with
 * its directory — putting the two in one module would make that pair circular.
 * This is the same shape `AuthModule` already uses to reach the driver.
 *
 * `AuthModule` is imported for `AuthGuard`'s own dependencies, the way
 * `ImpersonationModule` imports it — a guard placed on a route is constructed
 * in the module owning that route, so its collaborators have to be reachable
 * from here.
 */
@Module({
  imports: [
    AuthModule,
    AutomationModule,
    MessengerModule.forRoot({ imports: [AutomationModule] }),
  ],
  controllers: [WebhookRotationController],
  providers: [WebhookRotationService],
})
export class WebhookRotationModule {}
