import { Module } from '@nestjs/common';
import { BotClientRegistry } from './bot-client.registry';
import { BotViewRenderer } from './renderer';

/**
 * The messenger platform unit, as a Nest module. Two consumers import it:
 * `auth-service` (OTP delivery to a proven chat) and `bot-service` (every
 * screen) — which is what makes this a `platform/` unit rather than part of
 * `bot-app` (ADR-0009).
 */
@Module({
  providers: [BotClientRegistry, BotViewRenderer],
  exports: [BotClientRegistry, BotViewRenderer],
})
export class MessengerModule {}
