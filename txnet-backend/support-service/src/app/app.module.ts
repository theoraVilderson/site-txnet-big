import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { PublicRouteGuard, RateLimitGuard, TenantStatusGuard } from '@txnet-backend/shared-core';

import { SupportAgentModule } from './agent/agent.module';
import { SupportCannedModule } from './canned/canned.module';
import { SupportLifecycleModule } from './lifecycle/lifecycle.module';
import { SupportRetentionModule } from './retention/retention.module';
import { envConfigOptions } from './config/env.validation';
import { SupportConversationsModule } from './conversations/conversations.module';
import { HealthController } from './health.controller';
import { LanguageMiddleware } from './locale/language.middleware';
import { LocaleModule } from './locale/locale.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { IdentityMiddleware } from './request/identity.middleware';

/**
 * support-service (ADR-0112). The shared guards every tenant-facing app
 * registers (C-11): a suspended tenant's routes are refused here as anywhere.
 */
/** The service-to-service seam: reached by the platform's processes, never through Traefik. */
const INTERNAL_ROUTES = 'internal/*path';

@Module({
  imports: [ConfigModule.forRoot(envConfigOptions), PrismaModule, RedisModule, LocaleModule, SupportConversationsModule, SupportAgentModule, SupportCannedModule, SupportLifecycleModule, SupportRetentionModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: PublicRouteGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: TenantStatusGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(LanguageMiddleware).forRoutes('{*path}');
    // `ServiceOnlyGuard` is the whole door on `internal/*` (F-033-k): no gate, no identity.
    consumer.apply(IdentityMiddleware).exclude('health', INTERNAL_ROUTES).forRoutes('{*path}');
  }
}
