import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type ObjectDriver, ObjectStorage, objectDriverFromConfig, prismaStoredObjects } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import { FilesController, PrivateFilesController } from './files.controller';
import { GuideMediaController, GuideMediaInternalController } from './guide-media.controller';
import { OBJECT_DRIVER } from './object-driver';
import { PlatformTenant } from './platform-tenant';
import { StorageQuota } from './storage-quota';

/**
 * Object storage's serving routes (F-018-m; guide media, F-018-m2-b), and the
 * port itself for this service's own uploads (F-018-h), and the reseller's
 * storage quota every upload checks first (`StorageQuota`, F-414-m).
 *
 * On `PrismaService` — the app pool, extended with `withTenant` — so every
 * `stored_object` query is scoped and RLS-bound to the tenant in scope.
 */
@Module({
  controllers: [FilesController, PrivateFilesController, GuideMediaController, GuideMediaInternalController],
  providers: [
    PlatformTenant,
    StorageQuota,
    {
      provide: OBJECT_DRIVER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvConfig, true>) => objectDriverFromConfig((name) => config.get(name, { infer: true })),
    },
    {
      provide: ObjectStorage,
      inject: [OBJECT_DRIVER, PrismaService],
      useFactory: (driver: ObjectDriver, prisma: PrismaService) => new ObjectStorage(driver, prismaStoredObjects(prisma)),
    },
  ],
  exports: [ObjectStorage, PlatformTenant, StorageQuota],
})
export class FilesModule {}
