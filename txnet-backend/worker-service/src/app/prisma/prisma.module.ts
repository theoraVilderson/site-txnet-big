import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CrossTenantPrismaService } from './cross-tenant-prisma.service';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new PrismaService(config.getOrThrow<string>('DATABASE_APP_URL')),
    },
    {
      provide: CrossTenantPrismaService,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new CrossTenantPrismaService(config.getOrThrow<string>('DATABASE_CROSS_TENANT_URL')),
    },
  ],
  exports: [PrismaService, CrossTenantPrismaService],
})
export class PrismaModule {}
