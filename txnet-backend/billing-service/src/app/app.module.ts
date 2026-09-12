import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { RateLimitGuard } from '@txnet-backend/shared-core';

import { envConfigOptions } from './config/env.validation';
import { HealthController } from './health.controller';
import { LanguageMiddleware } from './locale/language.middleware';
import { LocaleModule } from './locale/locale.module';
import { CouponModule } from './payment/coupon/coupon.module';
import { DepositModule } from './payment/deposit/deposit.module';
import { GatewayModule } from './payment/gateway/gateway.module';
import { GiftModule } from './payment/gift/gift.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { CallbackTenantMiddleware } from './request/callback-tenant.middleware';
import { IdentityMiddleware } from './request/identity.middleware';
import { WalletModule } from './wallet/wallet.module';

/**
 * The one route outside the gate that is not the health check. Spelled once,
 * because the exclusion and the middleware that replaces it must name the same
 * path: an `exclude` that drifted from the `forRoutes` below would be a public
 * route with no tenant, which is a 500 per callback rather than a leak — but
 * the reverse drift is a gated route with no identity.
 */
const CALLBACK_ROUTE = 'billing/deposit/callback';

@Module({
  imports: [
    ConfigModule.forRoot(envConfigOptions),
    PrismaModule,
    RedisModule,
    LocaleModule,
    WalletModule,
    GatewayModule,
    CouponModule,
    DepositModule,
    GiftModule,
  ],
  controllers: [HealthController],
  providers: [
    // Every billing route is rate-limited per user (F-092-r): a route opts in
    // with `@RateLimit`, and `request/rate-limit-coverage.spec.ts` fails on one
    // that did not. Guards run after the middleware below, so the identity a
    // bucket is built from is already there.
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Language first, so the 401 IdentityMiddleware throws is translated.
    consumer.apply(LanguageMiddleware).forRoutes('*');
    // Every route but the container health check and the gateway callback
    // requires the gate's identity and runs inside its tenant (F-092-a). A new
    // controller is covered without opting in; leaving one out is the edit that
    // has to be made on purpose — and there are exactly two, both below.
    consumer
      .apply(IdentityMiddleware)
      .exclude('health', CALLBACK_ROUTE)
      .forRoutes('*');
    // The callback is public because a bank redirects a browser to it, so there
    // is no identity to read and the Host is the only claim it carries
    // (F-092-j, ADR-0025). This resolves that Host to a tenant or answers a
    // neutral 404 — and it is a middleware, not a guard, because the rate
    // limiter counts on the tenant in context and guards run after these.
    consumer.apply(CallbackTenantMiddleware).forRoutes(CALLBACK_ROUTE);
  }
}
