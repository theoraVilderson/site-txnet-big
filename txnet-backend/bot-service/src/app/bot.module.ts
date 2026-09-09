import { Module } from '@nestjs/common';
import { MessengerModule } from '@txnet-backend/messenger';
import { AuthApiModule } from './auth-api/auth-api.module';
import { ConversationStore } from './conversation/conversation.store';
import { ConversationRouter } from './conversation/router';
import { BotDispatcher } from './conversation/bot.dispatcher';
import { AccountAddFlow } from './flows/account-add.flow';
import { AccountsFlow } from './flows/accounts.flow';
import { ForgotFlow } from './flows/forgot.flow';
import { LoginFlow } from './flows/login.flow';
import { OtpStep } from './flows/otp.step';
import { PhoneNumbers } from './flows/phone-number';
import { RegisterFlow } from './flows/register.flow';
import { AccountSwitcher } from './session/account-switcher';
import { BotSessionStore } from './session/bot-session.store';
import { ChatAccess } from './session/chat-access';
import { BotIntegrationModule } from './webhook/bot-integration.module';
import { BotWebhookRegistrar } from './webhook/bot-webhook.registrar';
import { UpdateNormalizer } from './webhook/update.normalizer';
import { WebhookController } from './webhook/webhook.controller';

/**
 * `bot-app`: conversation state and screens, written once for both messengers.
 * It owns no tables and no rules — `AuthApiModule` is the only way out
 * (ADR-0009).
 */
@Module({
  imports: [
    // This service owns no schema and no vault, so `messenger`'s integration
    // directory is answered by `auth-service` over the service seam (F-320,
    // ADR-0011).
    BotIntegrationModule,
    MessengerModule.forRoot({ imports: [BotIntegrationModule] }),
    AuthApiModule,
  ],
  controllers: [WebhookController],
  providers: [
    UpdateNormalizer,
    BotDispatcher,
    ConversationRouter,
    ConversationStore,
    BotSessionStore,
    ChatAccess,
    AccountSwitcher,
    OtpStep,
    PhoneNumbers,
    LoginFlow,
    RegisterFlow,
    ForgotFlow,
    AccountsFlow,
    AccountAddFlow,
    BotWebhookRegistrar,
  ],
})
export class BotModule {}
