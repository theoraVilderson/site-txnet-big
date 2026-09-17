/**
 * Put a tenant's SMS line into its vault (F-018-a): `sms_api_key` and
 * `sms_sender_line`, the singular label `SmsOtpSender` and the campaign line
 * read.
 *
 * An entry point inside `auth-service` for `seed-bot-integration.ts`'s reason:
 * the vault has one owner, and a standalone script would be a second copy of
 * its crypto. The values arrive as `SEED_SMS_*` for the same reason too —
 * `SMS_API_KEY` / `SMS_SENDER` are no longer graced, so under their own names
 * they would refuse this very process's boot.
 *
 * For any tenant but the platform owner it also records the tenant's
 * `tenant_sms_config` as `own_credentials`; the owner's line is the platform's
 * and needs no row. Idempotent: `put` burns no version on an unchanged value.
 *
 * Run it through `scripts/seed-sms-line.sh`.
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TenantCredentialKind, TenantSmsMode, TenantType } from '@prisma/client';
import { CredentialVaultService } from '@txnet-backend/shared-core';
import { AppModule } from './app/app.module';
import { CrossTenantPrismaService } from './app/prisma/cross-tenant-prisma.service';

function required(name: string): string {
  const value = (process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required and was empty`);
  return value;
}

async function main(): Promise<void> {
  const logger = new Logger('seed-sms-line');
  const apiKey = required('SEED_SMS_API_KEY');
  const sender = (process.env['SEED_SMS_SENDER'] ?? '').trim();
  const tenantSlug = (process.env['SEED_SMS_TENANT'] ?? '').trim() || 'platform_owner';

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn', 'log'] });
  try {
    const prisma = app.get(CrossTenantPrismaService);
    const vault = app.get(CredentialVaultService);
    if (!vault.available) {
      throw new Error('the credential vault is unavailable — VAULT_KEK_FILE must point at a readable key');
    }

    const tenant = await prisma.tenant.findFirst({
      where: { slug: tenantSlug },
      select: { id: true, slug: true, tenantType: true },
    });
    if (!tenant) throw new Error(`no tenant with slug "${tenantSlug}" — run \`npm run prisma:seed\` first`);

    // `createdBy` unset: it is the acting user's uuid, and no user runs this.
    await vault.put({ tenantId: tenant.id, kind: TenantCredentialKind.sms_api_key }, apiKey);
    if (sender) await vault.put({ tenantId: tenant.id, kind: TenantCredentialKind.sms_sender_line }, sender);

    if (tenant.tenantType !== TenantType.platform_owner) {
      await prisma.tenantSmsConfig.upsert({
        where: { tenantId: tenant.id },
        create: { tenantId: tenant.id, mode: TenantSmsMode.own_credentials },
        update: { mode: TenantSmsMode.own_credentials, isActive: true },
      });
    }

    logger.log(`stored the SMS line${sender ? ' and sender' : ''} for tenant ${tenant.slug}`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  // The message only ever names the variable or the tenant, never a secret.
  new Logger('seed-sms-line').error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
