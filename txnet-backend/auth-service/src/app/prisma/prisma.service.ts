import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

/**
 * The application's connection to Postgres.
 *
 * **Not `DATABASE_URL`.** Since F-066-m-a the schema is protected by Row-Level
 * Security, and RLS is not enforced against a superuser or against a table's
 * own owner — which is exactly what `DATABASE_URL` is, because it is the
 * connection `prisma migrate` uses to create those tables. Connecting the
 * running service with it would leave every policy in place and inert.
 *
 * So the service connects as `DATABASE_APP_URL`: a login role that is a member
 * of `txnet_app`, owns nothing, and carries `NOBYPASSRLS`. There is no fallback
 * to `DATABASE_URL` if it is unset — a fallback here is a silent return to no
 * isolation at all, which is the same reasoning `CredentialEnvGuard` refuses a
 * boot on (tenant invariant 12).
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  // `this.constructor.name`, not `PrismaService.name`: since F-066-m-b there
  // are two of these in one process, and an operator reading "connected to
  // database" twice needs to know which pool each line is about.
  private readonly logger = new Logger(this.constructor.name);

  constructor(datasourceUrl?: string) {
    super(datasourceUrl ? { datasourceUrl } : undefined);
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('connected to database');
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
