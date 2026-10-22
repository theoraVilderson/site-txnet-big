import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessengerModule } from '@txnet-backend/messenger';
import { AuthApiModule } from './auth-api/auth-api.module';
import { ConversationStore } from './conversation/conversation.store';
import { ConversationRouter } from './conversation/router';
import { BotDispatcher } from './conversation/bot.dispatcher';
import { AccountAddFlow } from './flows/account-add.flow';
import { AccountsFlow } from './flows/accounts.flow';
import { TimeZoneFlow } from './flows/time-zone.flow';
import { LotteryFlow } from './flows/lottery.flow';
import { RenewalFlow } from './flows/renewal.flow';
import { ServicesFlow } from './flows/services.flow';
import { ChatFiles } from './flows/chat-files';
import { SupportFlow } from './flows/support.flow';
import { SupportApiClient } from './support-api/support-api.client';
import { GuideFlow } from './flows/guide.flow';
import { GuideApiClient } from './guide-api/guide-api.client';
import { GuideMediaSender, guideFileFetcher } from './guide-api/guide-media.sender';
import { RedisService } from './redis/redis.service';
import { WheelFlow } from './flows/wheel.flow';
import { AiApiClient } from './suggestion/ai-api.client';
import { SuggestionOptOut } from './suggestion/suggestion-opt-out';
import { ForgotFlow } from './flows/forgot.flow';
import { LoginFlow } from './flows/login.flow';
import { OtpStep } from './flows/otp.step';
import { PhoneNumbers } from './flows/phone-number';
import { RegisterFlow } from './flows/register.flow';
import { ResellerCampaignFlow } from './flows/reseller-campaign.flow';
import { ResellerFlow } from './flows/reseller.flow';
import { TopUpFlow } from './flows/top-up.flow';
import { TransferPayFlow } from './flows/transfer-pay.flow';
import { TransferReviewFlow } from './flows/transfer-review.flow';
import { ChatMenu } from './conversation/chat-menu';
import { InChatPayment } from './flows/in-chat-payment';
import { BillingApiClient } from './billing-api/billing-api.client';
import { NotificationApiClient } from './notification-api/notification-api.client';
import { TenantApiClient } from './tenant-api/tenant-api.client';
import { AccountSwitcher } from './session/account-switcher';
import { BotSessionStore } from './session/bot-session.store';
import { ChatAccess } from './session/chat-access';
import { BotIntegrationModule } from './webhook/bot-integration.module';
import { BotWebhookRegistrar } from './webhook/bot-webhook.registrar';
import { BotDispatchController } from './webhook/bot-dispatch.controller';
import { StaleUpdateNotice } from './webhook/stale-update';
import { InvoiceLinkController } from './webhook/invoice-link.controller';
import { BotUpdatePublisher } from './webhook/bot-update.publisher';
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
  // Two doors, and only one of them is on the internet. `WebhookController`
  // is the platforms' (verify, enqueue, 200); `BotDispatchController` is
  // `worker-service`'s, behind the service token, and is where the
  // conversation actually runs (F-067-b).
  controllers: [WebhookController, BotDispatchController, InvoiceLinkController],
  providers: [
    UpdateNormalizer,
    BotUpdatePublisher,
    BotDispatcher,
    StaleUpdateNotice,
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
    TimeZoneFlow,
    WheelFlow,
    LotteryFlow,
    ServicesFlow,
    RenewalFlow,
    SupportApiClient,
    ChatFiles,
    SupportFlow,
    GuideApiClient,
    GuideFlow,
    {
      provide: GuideMediaSender,
      useFactory: (redis: RedisService, config: ConfigService) => new GuideMediaSender(redis, guideFileFetcher(config)),
      inject: [RedisService, ConfigService],
    },
    AiApiClient,
    SuggestionOptOut,
    AccountAddFlow,
    BillingApiClient,
    TenantApiClient,
    NotificationApiClient,
    TopUpFlow,
    // F-805-b: a manual transfer's proof from the payer, and its review by whoever may confirm it.
    TransferPayFlow,
    TransferReviewFlow,
    ChatMenu,
    ResellerFlow,
    ResellerCampaignFlow,
    InChatPayment,
    BotWebhookRegistrar,
  ],
})
export class BotModule {}
