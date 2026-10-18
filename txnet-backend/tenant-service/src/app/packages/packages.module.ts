import { Module } from '@nestjs/common';
import { TRANSLATOR, translatorFromEnv } from '@txnet-backend/shared-core';

import { LocaleModule } from '../locale/locale.module';
import { LocaleService } from '../locale/locale.service';
import { PACKAGE_TEXT_STORE, PackageTextService } from './package-texts';
import { PackageTranslationsController } from './package-translations.controller';
import { PackageTranslationsService } from './package-translations.service';
import { TenantPackageController } from './tenant-package.controller';
import { TenantPackageService } from './tenant-package.service';

/**
 * The packages the platform sells resellers (F-018-d, F-018-o), moved out of
 * `auth-service` with F-018-u (ADR-0058). Their names and descriptions are
 * locale-service text, drafted by the `Translator` (ADR-0154 decision 5).
 *
 * `PrismaModule` and `RedisModule` are `@Global`, so neither is imported here;
 * the two pools the service injects come from there.
 *
 * The translations controller is listed first: its `translations` path would
 * otherwise reach `GET :id`, whose UUID pipe refuses it.
 */
@Module({
  imports: [LocaleModule],
  controllers: [PackageTranslationsController, TenantPackageController],
  providers: [
    TenantPackageService,
    PackageTranslationsService,
    PackageTextService,
    { provide: PACKAGE_TEXT_STORE, inject: [LocaleService], useFactory: (locale: LocaleService) => locale.textStore() },
    { provide: TRANSLATOR, useFactory: () => translatorFromEnv() },
  ],
})
export class PackagesModule {}
