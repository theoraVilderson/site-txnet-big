/**
 * Provision one `automation.BotIntegration` and its two vault credentials
 * (F-069).
 *
 * ## Why this is an entry point and not a script in `scripts/`
 *
 * `prisma/seed.js` is plain CommonJS and bootstraps rows it can write with
 * nothing but a Prisma client. A bot integration is not that: its token and
 * webhook secret are *vault* values, and ADR-0026 gives the vault one owner.
 * Writing them from a standalone script would mean a second copy of the KEK
 * parsing, the per-tenant DEK wrap, the AES-GCM seal, the fingerprint and the
 * supersede-then-insert ordering — security-critical code, duplicated, free to
 * drift. So this runs *inside* `auth-service` as a second webpack entry and
 * calls `CredentialVaultService.put` like every other writer does.
 *
 * ## Why the token does not arrive under its own name
 *
 * `TELEGRAM_BOT_TOKEN` / `BALE_BOT_TOKEN` / `*_WEBHOOK_SECRET` are in
 * `CREDENTIAL_ENV_VARS` and are no longer graced (F-066-i), so `AppModule`
 * refuses to boot when any of them is set — which is the whole point of that
 * guard, and this script must not be the exception that hollows it out. The
 * values therefore arrive as `SEED_*`, are read once, and are never written
 * anywhere but the vault.
 *
 * Idempotent: re-running with the same values updates the row in place and
 * `put` recognises an unchanged secret by its fingerprint, so no version is
 * burned and no grace window opens.
 *
 * Run it through `scripts/seed-bot-integration.sh`, which reads the values out
 * of `.env.dev` and renames them on the way in.
 */
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TenantCredentialKind } from '@prisma/client';
import { newWebhookPath } from '@txnet-backend/messenger';
import { AppModule } from './app/app.module';
import { CrossTenantPrismaService } from './app/prisma/cross-tenant-prisma.service';
import { CredentialVaultService } from './app/tenant/vault/credential-vault.service';

const TOKEN_KIND: Record<string, TenantCredentialKind> = {
  telegram: TenantCredentialKind.telegram_bot_token,
  bale: TenantCredentialKind.bale_bot_token,
};

interface Options {
  platform: 'telegram' | 'bale';
  botUsername: string;
  token: string;
  webhookSecret: string;
  tenantSlug: string;
}

function required(name: string): string {
  const value = (process.env[name] ?? '').trim();
  if (!value) {
    throw new Error(`${name} is required and was empty`);
  }
  return value;
}

function readOptions(): Options {
  const platform = required('SEED_BOT_PLATFORM').toLowerCase();
  if (platform !== 'telegram' && platform !== 'bale') {
    throw new Error(`SEED_BOT_PLATFORM must be telegram or bale, got "${platform}"`);
  }
  return {
    platform,
    botUsername: required('SEED_BOT_USERNAME').replace(/^@/, ''),
    token: required('SEED_BOT_TOKEN'),
    // Optional: a fresh secret is better than a reused one, so an absent value
    // is not an error. `newWebhookPath()` is 32 bytes of hex, which is exactly
    // what a webhook secret needs to be.
    webhookSecret: (process.env['SEED_BOT_WEBHOOK_SECRET'] ?? '').trim() || newWebhookPath(),
    tenantSlug: (process.env['SEED_BOT_TENANT'] ?? '').trim() || 'platform_owner',
  };
}

async function main(): Promise<void> {
  const logger = new Logger('seed-bot-integration');
  const options = readOptions();

  // 'log' has to be in this list or the summary at the end is swallowed:
  // the level filter is global, so it applies to this script's own Logger
  // just as much as to Nest's boot chatter. 'debug'/'verbose' stay off, which
  // is the noise this list exists to suppress.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  try {
    const prisma = app.get(CrossTenantPrismaService);
    const vault = app.get(CredentialVaultService);

    if (!vault.available) {
      throw new Error(
        'the credential vault is unavailable — VAULT_KEK_FILE must point at a readable key',
      );
    }

    const tenant = await prisma.tenant.findFirst({
      where: { slug: options.tenantSlug },
      select: { id: true, slug: true },
    });
    if (!tenant) {
      throw new Error(
        `no tenant with slug "${options.tenantSlug}" — run \`npm run prisma:seed\` first`,
      );
    }

    // The row is addressed by (tenant, platform, botUsername), which is its
    // own unique key, so re-running is an update rather than a duplicate.
    const existing = await prisma.botIntegration.findFirst({
      where: {
        tenantId: tenant.id,
        platform: options.platform,
        botUsername: options.botUsername,
      },
    });

    // The webhook path is rotated only when there is none: it is the bot's
    // whole address, and re-minting it on every run would silently orphan the
    // registration currently live upstream (F-066-j).
    const webhookPath = existing?.webhookPath ?? newWebhookPath();
    const credentialRef = existing?.credentialRef ?? `bot:${options.platform}:${options.botUsername}`;

    // Vault first. A row whose credentials are missing is the one state
    // `BotClientRegistry` cannot recover from on its own, so it must not exist
    // even briefly.
    //
    // `createdBy` is left unset on purpose. It is a nullable **uuid** column
    // holding the acting user's id (`tenant.prisma`), not a free-text source
    // label — passing the script's own name gets `Inconsistent column data:
    // Error creating UUID` from Prisma. No human runs this, so null is the
    // honest answer; the audit trail F-066-g writes is the record that this
    // happened.
    await vault.put(
      { tenantId: tenant.id, kind: TOKEN_KIND[options.platform], label: credentialRef },
      options.token,
    );
    await vault.put(
      { tenantId: tenant.id, kind: TenantCredentialKind.webhook_secret, label: credentialRef },
      options.webhookSecret,
    );

    const row = existing
      ? await prisma.botIntegration.update({
          where: { id: existing.id },
          data: { credentialRef, status: 'pending', lastErrorAt: null },
        })
      : await prisma.botIntegration.create({
          data: {
            tenantId: tenant.id,
            platform: options.platform,
            botUsername: options.botUsername,
            credentialRef,
            webhookPath,
            status: 'pending',
          },
        });

    // `status: pending` is deliberate on both paths: `BotWebhookRegistrar`
    // flips it to `active` when it has actually registered the webhook
    // upstream, and claiming `active` here would be this script asserting
    // something it never checked.
    logger.log(
      `${existing ? 'updated' : 'created'} ${row.platform} @${row.botUsername} ` +
        `for tenant ${tenant.slug} (id ${row.id}); restart bot-service to register its webhook`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  // The message only ever names the variable or the row, never a secret.
  new Logger('seed-bot-integration').error(
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
