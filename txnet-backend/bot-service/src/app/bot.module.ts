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
import { RegisterFlow } from './flows/register.flow';
import { BotSessionStore } from './session/bot-session.store';
import { ChatAccess } from './session/chat-access';
import { BotWebhookRegistrar } from './webhook/bot-webhook.registrar';
import { UpdateNormalizer } from './webhook/update.normalizer';
import { WebhookController } from './webhook/webhook.controller';

/**
 * `bot-app`: conversation state and screens, written once for both messengers.
 * It owns no tables and no rules — `AuthApiModule` is the only way out
 * (ADR-0009).
 */
@Module({
  imports: [MessengerModule, AuthApiModule],
  controllers: [WebhookController],
  providers: [
    UpdateNormalizer,
    BotDispatcher,
    ConversationRouter,
    ConversationStore,
    BotSessionStore,
    ChatAccess,
    OtpStep,
    LoginFlow,
    RegisterFlow,
    ForgotFlow,
    AccountsFlow,
    AccountAddFlow,
    BotWebhookRegistrar,
  ],
})
export class BotModule {}
