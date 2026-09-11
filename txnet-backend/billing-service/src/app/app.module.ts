import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller';
import { AppService } from './app.service';
import { envConfigOptions } from './config/env.validation';

@Module({
  imports: [ConfigModule.forRoot(envConfigOptions)],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
