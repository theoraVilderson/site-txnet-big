import { TenantCredentialKind, TenantCredentialStatus } from '@prisma/client';
import { CredentialEnvGuard, GRACED_ENV_VARS } from './credential-env';
import { CredentialUnavailable } from './credential-vault.service';
import { VaultDecryptionError } from './vault.crypto';
import { smsLineConfigured, smsLineCredentials } from './sms-line-credentials';

/**
 * F-018-a — a tenant's SMS line is two vault values, and nothing else carries
 * it. The half that fails silently is the environment: a leftover
 * `SMS_API_KEY` would keep the OTP gateway working with the vault never read.
 */
const TENANT = 'tenant-1';

function vault(values: Partial<Record<TenantCredentialKind, string | Error>>) {
  return {
    use: vi.fn(async (ref: { tenantId: string; kind: TenantCredentialKind }) => {
      const value = values[ref.kind];
      if (value === undefined) throw new CredentialUnavailable(ref, 'missing');
      if (value instanceof Error) throw value;
      return value;
    }),
    summary: vi.fn(async (ref: { kind: TenantCredentialKind }) =>
      values[ref.kind] === undefined
        ? null
        : { status: TenantCredentialStatus.active, expiresAt: null as Date | null },
    ),
  };
}

describe('smsLineCredentials', () => {
  it("reads the key and the sender line from the tenant's own vault, naming the caller", async () => {
    const v = vault({ sms_api_key: 'user@pass', sms_sender_line: '3000' });

    await expect(smsLineCredentials(v, TENANT, 'auth:SmsOtpSender')).resolves.toEqual({
      apiKey: 'user@pass',
      sender: '3000',
    });
    expect(v.use).toHaveBeenCalledWith(
      { tenantId: TENANT, kind: TenantCredentialKind.sms_api_key },
      { caller: 'auth:SmsOtpSender' },
    );
    expect(v.use).toHaveBeenCalledWith(
      { tenantId: TENANT, kind: TenantCredentialKind.sms_sender_line },
      { caller: 'auth:SmsOtpSender' },
    );
  });

  it('is no line without a key, and a line with an empty sender without a sender', async () => {
    await expect(smsLineCredentials(vault({ sms_sender_line: '3000' }), TENANT, 'x')).resolves.toBeNull();
    await expect(smsLineCredentials(vault({ sms_api_key: 'k' }), TENANT, 'x')).resolves.toEqual({
      apiKey: 'k',
      sender: '',
    });
  });

  it('lets a broken vault through rather than reporting "not configured"', async () => {
    const v = vault({ sms_api_key: new VaultDecryptionError('sms_api_key for tenant-1') });
    await expect(smsLineCredentials(v, TENANT, 'x')).rejects.toBeInstanceOf(VaultDecryptionError);
  });
});

describe('smsLineConfigured', () => {
  it('asks the summary, which decrypts nothing and writes no audit row', async () => {
    const v = vault({ sms_api_key: 'k' });
    await expect(smsLineConfigured(v as never, TENANT)).resolves.toBe(true);
    await expect(smsLineConfigured(vault({}) as never, TENANT)).resolves.toBe(false);
    expect(v.use).not.toHaveBeenCalled();
  });

  it('is not configured when the active key has expired', async () => {
    const v = vault({ sms_api_key: 'k' });
    v.summary.mockResolvedValueOnce({ status: TenantCredentialStatus.active, expiresAt: new Date(Date.now() - 1000) });
    await expect(smsLineConfigured(v as never, TENANT)).resolves.toBe(false);
  });
});

describe('F-1216 — the SMS variables are no longer graced', () => {
  it('graces nothing', () => {
    expect(GRACED_ENV_VARS).toEqual({});
  });

  it('refuses to boot on SMS_API_KEY or SMS_SENDER', () => {
    const guard = new CredentialEnvGuard();
    const saved = { ...process.env };
    try {
      process.env['SMS_API_KEY'] = 'user@pass';
      expect(() => guard.onModuleInit()).toThrow(/SMS_API_KEY/);
      delete process.env['SMS_API_KEY'];
      process.env['SMS_SENDER'] = '3000';
      expect(() => guard.onModuleInit()).toThrow(/SMS_SENDER/);
    } finally {
      process.env = saved;
    }
  });
});
