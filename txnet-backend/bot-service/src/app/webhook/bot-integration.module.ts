import { Module } from '@nestjs/common';
import { BOT_INTEGRATION_DIRECTORY } from '@txnet-backend/messenger';
import { AuthApiBotIntegrationDirectory } from './bot-integration.directory';

/**
 * The seam `messenger` resolves bots through in this service (F-320).
 *
 * A module of its own so there is exactly one instance: `MessengerModule` asks
 * for it by token, while `BotWebhookRegistrar` asks for the class, which also
 * answers the two boot-time questions that are this service's own rather than
 * `messenger`'s.
 */
@Module({
  providers: [
    AuthApiBotIntegrationDirectory,
    {
      provide: BOT_INTEGRATION_DIRECTORY,
      useExisting: AuthApiBotIntegrationDirectory,
    },
  ],
  exports: [AuthApiBotIntegrationDirectory, BOT_INTEGRATION_DIRECTORY],
})
export class BotIntegrationModule {}
