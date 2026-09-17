import { TenantCredentialKind, TenantCredentialStatus } from '@prisma/client';
import type { CredentialVaultService } from './credential-vault.service';
import { CredentialUnavailable } from './credential-vault.service';

/** What an SMS gateway call needs from a tenant: the account and the number it signs as. */
export interface SmsLineCredentials {
  apiKey: string;
  sender: string;
}

/**
 * **A tenant's SMS line, read from its vault** (F-018-a) — `sms_api_key` and
 * `sms_sender_line`, singular label. The one spelling for the two processes
 * that send SMS: `auth-service`'s OTP sender and `notification-service`'s
 * campaign line, both on the platform owner's vault today.
 *
 * `null` when there is no usable key: that is "not configured", which each
 * caller already has an answer for. A missing sender is `''`, as an unset
 * `SMS_SENDER` was. Anything else — a value that fails to decrypt, a failed
 * audit write — is thrown, because reporting a broken vault as "not configured"
 * is how it stays broken.
 *
 * Each call is two `use`s and so two audit rows (F-1215): read once per send
 * or per delivery run, never cached across them, so a rotation takes effect on
 * the next one.
 */
export async function smsLineCredentials(
  vault: Pick<CredentialVaultService, 'use'>,
  tenantId: string,
  caller: string,
): Promise<SmsLineCredentials | null> {
  const apiKey = await orNull(
    vault.use({ tenantId, kind: TenantCredentialKind.sms_api_key }, { caller }),
  );
  if (!apiKey) return null;
  const sender = await orNull(
    vault.use({ tenantId, kind: TenantCredentialKind.sms_sender_line }, { caller }),
  );
  return { apiKey, sender: sender ?? '' };
}

/** Whether a tenant has a usable SMS key — from the summary, so nothing is decrypted or audited. */
export async function smsLineConfigured(
  vault: Pick<CredentialVaultService, 'summary'>,
  tenantId: string,
): Promise<boolean> {
  const key = await vault.summary({ tenantId, kind: TenantCredentialKind.sms_api_key });
  return (
    !!key &&
    key.status === TenantCredentialStatus.active &&
    (!key.expiresAt || key.expiresAt.getTime() > Date.now())
  );
}

async function orNull(value: Promise<string>): Promise<string | null> {
  try {
    return await value;
  } catch (error) {
    if (error instanceof CredentialUnavailable) return null;
    throw error;
  }
}
