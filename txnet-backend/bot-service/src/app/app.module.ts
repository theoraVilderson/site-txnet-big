import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { envConfigOptions } from './config/env.validation';
import { RedisModule } from './redis/redis.module';
import { LocaleModule } from './locale/locale.module';
import { BotModule } from './bot.module';

@Module({
  imports: [
    ConfigModule.forRoot(envConfigOptions),
    RedisModule,
    LocaleModule,
    BotModule,
  ],
})
export class AppModule {}
