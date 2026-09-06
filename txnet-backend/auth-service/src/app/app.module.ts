import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AuthModule } from './auth/auth.module';
import { AccountSwitchModule } from './account-switch/account-switch.module';
import { LocaleModule } from './locale/locale.module';
import { LanguageMiddleware } from './common/middlewares/language.middleware';
import { ServiceCallerMiddleware } from './common/security/service-caller';
import { SwitchScopeMiddleware } from './common/security/switch-scope.middleware';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    RedisModule,
    AuthModule,
    AccountSwitchModule,
    LocaleModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // ServiceCallerMiddleware runs on every route: the guards and the
    // rate-limit keys below read what it decided, so it cannot be optional.
    // SwitchScopeMiddleware follows it — it reads that decision to tell a bot
    // chat from a browser, and mints the browser's `device_id` (ADR-0015).
    consumer
      .apply(ServiceCallerMiddleware, SwitchScopeMiddleware, LanguageMiddleware)
      .forRoutes('*');
  }
}
