import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { RateLimitGuard, TenantStatusGuard } from '@txnet-backend/shared-core';

import { AttentionModule } from './attention/attention.module';
import { DecisionModule } from './decision/decision.module';
import { BrokerModule } from './broker/broker.module';
import { envConfigOptions } from './config/env.validation';
import { FloorModule } from './floor/floor.module';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { ProfileModule } from './profile/profile.module';
import { RedisModule } from './redis/redis.module';
import { IdentityMiddleware } from './request/identity.middleware';
import { TriggersModule } from './triggers/triggers.module';

/**
 * ai-service (ADR-0109 point 2). Its tenant routes are under `api/ai/*`,
 * reached through Traefik behind `my-auth` (F-038-h, the user's suggestion
 * card): `IdentityMiddleware` opens the gate's tenant scope there, the status
 * guard judges it (C-11) and `@RateLimit` routes are counted per user.
 * `/health` and the service-only seams under `api/internal/ai/*` take no
 * identity — `ServiceOnlyGuard` is their whole door, and no Traefik rule
 * reaches them.
 */
@Module({
  imports: [ConfigModule.forRoot(envConfigOptions), PrismaModule, RedisModule, BrokerModule, TriggersModule, ProfileModule, AttentionModule, DecisionModule, FloorModule],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: TenantStatusGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(IdentityMiddleware).forRoutes('api/ai/{*path}');
  }
}
