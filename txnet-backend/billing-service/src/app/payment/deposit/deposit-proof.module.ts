import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { objectDriverFromEnv, scannerFromEnv } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../../config/env.validation';
import { RECEIPT_POLICY } from '../manual/transfer-proof';
import { DepositProofController } from './deposit-proof.controller';
import { DepositProofService, PROOF_OBJECT_DRIVER, PROOF_VIRUS_SCANNER } from './deposit-proof.service';

type Config = ConfigService<EnvConfig, true>;

/**
 * A manual transfer's receipt and proof (F-805-a). Its own module so the
 * upload limits bind these routes only: multer refuses past them while the
 * body streams, so an oversized receipt is cut off, not buffered whole.
 */
@Module({
  imports: [
    MulterModule.register({ limits: { fileSize: RECEIPT_POLICY.maxBytes, files: 1, fields: 0 } }),
  ],
  controllers: [DepositProofController],
  providers: [
    DepositProofService,
    {
      provide: PROOF_OBJECT_DRIVER,
      inject: [ConfigService],
      useFactory: (config: Config) =>
        objectDriverFromEnv({ OBJECT_STORAGE_DRIVER: config.get('OBJECT_STORAGE_DRIVER', { infer: true }), OBJECT_STORAGE_LOCAL_ROOT: config.get('OBJECT_STORAGE_LOCAL_ROOT', { infer: true }) }),
    },
    {
      provide: PROOF_VIRUS_SCANNER,
      inject: [ConfigService],
      useFactory: (config: Config) => {
        const scanner = scannerFromEnv({ VIRUS_SCAN_DRIVER: config.get('VIRUS_SCAN_DRIVER', { infer: true }), CLAMD_ADDR: config.get('CLAMD_ADDR', { infer: true }) });
        if (scanner.name === 'none') new Logger('DepositProof').warn('VIRUS_SCAN_DRIVER=none: transfer receipts are stored unscanned (ADR-0113 point 4)');
        return scanner;
      },
    },
  ],
})
export class DepositProofModule {}
