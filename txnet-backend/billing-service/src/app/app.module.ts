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
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { IdentityMiddleware } from './request/identity.middleware';
import { WalletModule } from './wallet/wallet.module';

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
    // Every route but the container health check requires the gate's identity
    // and runs inside its tenant (F-092-a). A new controller is covered without
    // opting in; leaving one out is the edit that has to be made on purpose.
    consumer.apply(IdentityMiddleware).exclude('health').forRoutes('*');
  }
}
