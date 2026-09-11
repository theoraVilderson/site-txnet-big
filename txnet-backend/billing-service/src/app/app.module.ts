import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { envConfigOptions } from './config/env.validation';
import { HealthController } from './health.controller';
import { LanguageMiddleware } from './locale/language.middleware';
import { LocaleModule } from './locale/locale.module';
import { PrismaModule } from './prisma/prisma.module';
import { IdentityMiddleware } from './request/identity.middleware';

@Module({
  imports: [ConfigModule.forRoot(envConfigOptions), PrismaModule, LocaleModule],
  controllers: [HealthController],
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
