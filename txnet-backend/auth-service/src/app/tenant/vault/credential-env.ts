import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { TenantCredentialKind } from '@prisma/client';

/**
 * No tenant-owned credential is read from an environment variable (ADR-0026
 * rule 6, catalog 20.4 guarantee 2 — F-1216).
 *
 * The rule exists because of how the no-fallback rule actually gets violated:
 * not by someone deciding to read a secret from `.env`, but by a leftover
 * `TELEGRAM_BOT_TOKEN` that kept one tenant's bot working after multi-bot
 * shipped, so nobody noticed the vault was never wired up. A boot refusal is
 * the only check that fires before that becomes load-bearing.
 *
 * **Why an explicit list of names and not a pattern.** A regex over
 * `*_TOKEN|*_SECRET|*_API_KEY` cannot tell `JWT_ACCESS_SECRET` — this
 * platform's own signing key, which belongs in the environment — from
 * `TELEGRAM_BOT_TOKEN`, which is a tenant's property. Getting that wrong in
 * either direction is worse than the list: a pattern that catches platform
 * secrets refuses to boot a correct deployment, and one loosened until it
 * stops doing that no longer catches what it was written for. The distinction
 * is *ownership*, and ownership is not in the name.
 *
 * The list cannot rot silently either: {@link CREDENTIAL_ENV_VARS} is typed as
 * a total `Record<TenantCredentialKind, ...>`, so adding a member to the enum
 * fails the build until someone says which environment variables would have
 * carried it. That is the mechanical half of this rule; the refusal below is
 * the other.
 */

/**
 * Environment variables that would carry the *value* of a tenant-owned
 * credential of each kind.
 *
 * A variable naming a *location* is not on this list and never should be:
 * `VAULT_KEK_FILE` is a path, `TELEGRAM_API_BASE` is a hostname,
 * `*_WEBHOOK_PUBLIC_BASE` is a URL. ADR-0026 rule 6 forbids reading a
 * credential's value from the environment, and the whole reason `KekService`
 * takes a file path is that a path is not one.
 *
 * `*_WEBHOOK_SECRET` **is** on the list: catalog 20.4 names `webhook_secret`
 * as a vault kind, and the per-integration secret token F-066-i verifies on
 * every request is a tenant's, not the platform's.
 *
 * The names are the ones this codebase actually uses (`SMS_API_KEY`,
 * `TELEGRAM_BOT_TOKEN`) plus the provider-neutral name each remaining kind
 * implies. Vendor-specific guesses are deliberately absent: a name for an
 * integration nobody has built is a guess, and the row that builds one adds
 * its variable here in the same change — which is the same discipline the
 * grace table below asks for, from the other direction.
 */
export const CREDENTIAL_ENV_VARS: Record<TenantCredentialKind, string[]> = {
  telegram_bot_token: ['TELEGRAM_BOT_TOKEN'],
  bale_bot_token: ['BALE_BOT_TOKEN'],
  sms_api_key: ['SMS_API_KEY'],
  sms_sender_line: ['SMS_SENDER'],
  gateway_merchant_id: ['GATEWAY_MERCHANT_ID'],
  gateway_secret_key: ['GATEWAY_SECRET_KEY'],
  panel_credentials: ['PANEL_PASSWORD'],
  webhook_secret: ['TELEGRAM_WEBHOOK_SECRET', 'BALE_WEBHOOK_SECRET'],
  ai_provider_api_key: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
  source_panel_credentials: ['SOURCE_PANEL_PASSWORD'],
  cdn_dns_credentials: ['DNS_API_TOKEN'],
};

/**
 * Tenant-credential variables this deployment is still allowed to set, each
 * naming the backlog row that removes it.
 *
 * ADR-0026 states the cost of rule 6 plainly: *"it will refuse to boot a
 * currently working deployment. That is deliberate, and it is sequenced with
 * F-066-i so the tokens have somewhere to live first."* This table is that
 * sequencing, written where it is enforced rather than left as an intention in
 * a document.
 *
 * The four bot variables left it with F-066-i: `BotClientRegistry` now reads
 * every token and webhook secret from a tenant's `BotIntegration` and the
 * vault, so a deployment still setting one is refused rather than graced. What
 * remains is `SmsOtpSender`, which reads `SMS_API_KEY` and `SMS_SENDER` from
 * config the way the registry used to read the tokens — tenant property under
 * catalog 20.4, with no vault row to move to until F-018.
 *
 * **Emptying an entry is part of the row it names**, not a follow-up to it: the
 * row that gives a credential somewhere to live is the row that takes away its
 * variable, and splitting the two is how a leftover survives.
 *
 * Nothing else is graced. A variable in {@link CREDENTIAL_ENV_VARS} and not
 * here refuses the boot from the moment it is set, which is this guard's real
 * job — by the time a leftover is load-bearing it is too late to refuse it.
 */
export const GRACED_ENV_VARS: Readonly<Record<string, string>> = {
  SMS_API_KEY: 'F-018 — the tenant SMS integration moves into the vault',
  SMS_SENDER: 'F-018 — the tenant SMS integration moves into the vault',
};

/** One environment variable found holding a tenant credential. */
export interface CredentialEnvFinding {
  name: string;
  kind: TenantCredentialKind;
  /** The row that removes it, when it is graced; `null` when it is a refusal. */
  gracedFor: string | null;
}

/**
 * Which tenant-credential variables this environment actually sets.
 *
 * A variable present but **empty** is not set: docker compose passes an
 * unfilled `FOO=` through as `''`, which is the same shape `env.validation.ts`
 * already has to treat as absent. Refusing to boot over a variable nobody
 * filled in would make this guard the thing operators route around.
 *
 * Pure, so the whole rule is testable without booting Nest — the failure mode
 * that matters here is a *missed* variable, and that is silent.
 */
export function scanEnvForCredentials(
  env: Record<string, string | undefined>,
): CredentialEnvFinding[] {
  const findings: CredentialEnvFinding[] = [];
  for (const [kind, names] of Object.entries(CREDENTIAL_ENV_VARS)) {
    for (const name of names) {
      const value = env[name];
      if (value === undefined || value === '') continue;
      findings.push({
        name,
        kind: kind as TenantCredentialKind,
        gracedFor: GRACED_ENV_VARS[name] ?? null,
      });
    }
  }
  return findings;
}

/**
 * Refuses to start when a tenant credential is in the environment.
 *
 * Boot, not first use, for the same reason {@link KekService} loads its key at
 * boot: by the time the first tenant configures an integration the deployment
 * looks healthy, and the failure belongs to whoever is on call rather than to
 * whoever deployed it.
 */
@Injectable()
export class CredentialEnvGuard implements OnModuleInit {
  private readonly logger = new Logger(CredentialEnvGuard.name);

  // No constructor: `process.env` is read directly, and the rule itself lives
  // in `scanEnvForCredentials` above, which is where it is tested. A ctor
  // parameter here would be one more thing for Nest to try to inject.

  onModuleInit(): void {
    const findings = scanEnvForCredentials(process.env);
    const refused = findings.filter((f) => f.gracedFor === null);
    const graced = findings.filter((f) => f.gracedFor !== null);

    for (const finding of graced) {
      // Loud rather than silent: a grace period nobody sees expiring is how a
      // leftover survives the row that was supposed to remove it.
      this.logger.warn(
        `${finding.name} holds a tenant-owned credential (${finding.kind}) in ` +
          `the environment. This is allowed only until ${finding.gracedFor}. ` +
          `ADR-0026 rule 6.`,
      );
    }

    if (refused.length === 0) return;

    // The names, never the values — this message reaches a log.
    const list = refused
      .map((f) => `${f.name} (${f.kind})`)
      .join(', ');
    throw new Error(
      `Refusing to start: ${list} ${refused.length === 1 ? 'holds a' : 'hold'} ` +
        `tenant-owned credential${refused.length === 1 ? '' : 's'} in the ` +
        `environment. A tenant's secrets live in the Credential Vault and ` +
        `nowhere else (ADR-0026 rule 6). Store the value with ` +
        `CredentialVaultService.put() and unset the variable.`,
    );
  }
}
