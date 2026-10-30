import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { objectDriverFromConfig, scannerFromEnv } from '@txnet-backend/shared-core';

import { SupportAvailabilityModule } from '../availability/availability.module';
import type { EnvConfig } from '../config/env.validation';
import { LocaleModule } from '../locale/locale.module';
import { SupportNotifyModule } from '../notify/notify.module';
import { SupportRealtime } from '../realtime/support-realtime';
import { SUPPORT_OBJECT_DRIVER, SUPPORT_VIRUS_SCANNER, SupportAttachmentService } from './attachments.service';
import { SupportConversationsController } from './conversations.controller';
import { SupportConversationService } from './conversations.service';

type Config = ConfigService<EnvConfig, true>;

@Module({
  imports: [
    SupportAvailabilityModule,
    LocaleModule,
    SupportNotifyModule,
    // Uploads are held in memory (each file is capped) and scanned before
    // anything is written (F-033-f). Multer refuses past the caps itself, so an
    // oversized body is cut off while it streams, not after it arrived.
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: Config) => ({
        limits: {
          fileSize: config.get('SUPPORT_ATTACHMENT_MAX_BYTES', { infer: true }),
          files: config.get('SUPPORT_ATTACHMENTS_PER_MESSAGE', { infer: true }),
          fields: 1,
        },
      }),
    }),
  ],
  controllers: [SupportConversationsController],
  // Retention (F-033-n) deletes and archives through the same driver.
  exports: [SUPPORT_OBJECT_DRIVER],
  providers: [
    SupportConversationService,
    SupportAttachmentService,
    SupportRealtime,
    {
      provide: SUPPORT_OBJECT_DRIVER,
      inject: [ConfigService],
      useFactory: (config: Config) => objectDriverFromConfig((name) => config.get(name, { infer: true })),
    },
    {
      provide: SUPPORT_VIRUS_SCANNER,
      inject: [ConfigService],
      useFactory: (config: Config) => {
        const scanner = scannerFromEnv({
          VIRUS_SCAN_DRIVER: config.get('VIRUS_SCAN_DRIVER', { infer: true }),
          CLAMD_ADDR: config.get('CLAMD_ADDR', { infer: true }),
        });
        if (scanner.name === 'none') {
          new Logger('SupportAttachments').warn('VIRUS_SCAN_DRIVER=none: attachments are stored unscanned (ADR-0113 point 4)');
        }
        return scanner;
      },
    },
  ],
})
export class SupportConversationsModule {}
