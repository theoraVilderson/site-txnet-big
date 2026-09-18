import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ObjectStorage, objectDriverFromEnv, prismaStoredObjects } from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import { FilesController } from './files.controller';

/**
 * Object storage's serving route (F-018-m, `platform/object-storage`), and the
 * port itself for this service's own uploads (F-018-h).
 *
 * On `PrismaService` — the app pool, extended with `withTenant` — so every
 * `stored_object` query is scoped and RLS-bound to the tenant in scope.
 */
@Module({
  controllers: [FilesController],
  providers: [
    {
      provide: ObjectStorage,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService<EnvConfig, true>, prisma: PrismaService) =>
        new ObjectStorage(
          objectDriverFromEnv({
            OBJECT_STORAGE_DRIVER: config.get('OBJECT_STORAGE_DRIVER', { infer: true }),
            OBJECT_STORAGE_LOCAL_ROOT: config.get('OBJECT_STORAGE_LOCAL_ROOT', { infer: true }),
          }),
          prismaStoredObjects(prisma),
        ),
    },
  ],
  exports: [ObjectStorage],
})
export class FilesModule {}
