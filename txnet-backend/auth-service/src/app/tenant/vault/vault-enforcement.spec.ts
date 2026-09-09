import { TenantCredentialStatus } from '@prisma/client';
import {
  CREDENTIAL_ENV_VARS,
  CredentialEnvGuard,
  GRACED_ENV_VARS,
  scanEnvForCredentials,
} from './credential-env';
import { CredentialVaultService } from './credential-vault.service';

/**
 * F-066-g — the two halves of ADR-0026 rules 5 and 6, in one file because they
 * are one backlog item and the budget in `docs/CODE-LAYOUT.md` is one new
 * `*.spec.ts` per item.
 *
 * Both halves fail *silently* if they are wrong, which is what earns them the
 * slot: a variable the scan does not recognise boots a deployment that is
 * quietly reading a tenant's token out of `.env`, and a `use()` that returns a
 * plaintext without writing its row leaves an audit trail that is complete
 * only in appearance. Neither shows up in anything else.
 */
describe('F-1216 — no tenant credential comes from an environment variable', () => {
  it('finds a set variable and refuses it', () => {
    const found = scanEnvForCredentials({ OPENAI_API_KEY: 'sk-live' });
    expect(found).toEqual([
      { name: 'OPENAI_API_KEY', kind: 'ai_provider_api_key', gracedFor: null },
    ]);
  });

  it('treats an empty variable as unset', () => {
    // docker compose passes an unfilled `FOO=` through as ''. Refusing to boot
    // over one is how this guard would get routed around.
    expect(scanEnvForCredentials({ OPENAI_API_KEY: '' })).toEqual([]);
    expect(scanEnvForCredentials({})).toEqual([]);
  });

  it('does not claim a variable that names a location rather than a value', () => {
    // The distinction ADR-0026 rule 6 turns on, and the reason KekService takes
    // a path: a path, a hostname and a public base are not credentials.
    const env = {
      VAULT_KEK_FILE: '/run/secrets/vault-kek',
      TELEGRAM_API_BASE: 'https://api.telegram.org',
      TELEGRAM_WEBHOOK_PUBLIC_BASE: 'https://api.example.com',
      JWT_ACCESS_SECRET: 'this-platform-signs-with-it',
      SERVICE_AUTH_TOKEN: 'platform-internal',
    };
    expect(scanEnvForCredentials(env)).toEqual([]);
  });

  it('graces exactly the variables live code still reads, and nothing else', () => {
    const graced = Object.keys(GRACED_ENV_VARS);
    const known = Object.values(CREDENTIAL_ENV_VARS).flat();
    // A grace entry for a name the scan does not look at would be a comment
    // pretending to be an exemption.
    expect(known).toEqual(expect.arrayContaining(graced));
    // The list is pinned so emptying it is a deliberate edit with a diff, not
    // something a later session widens by one variable at a time.
    // The four bot variables left with F-066-i, which gave their values a
    // vault row to live in. What is left is SMS, until F-018.
    expect(graced.sort()).toEqual(['SMS_API_KEY', 'SMS_SENDER']);
    // Every graced name says which row removes it.
    for (const name of graced) expect(GRACED_ENV_VARS[name]).toMatch(/^F-\d/);
  });

  it('boots on a graced variable and refuses on any other', () => {
    const guard = new CredentialEnvGuard();
    const saved = { ...process.env };
    try {
      process.env['SMS_API_KEY'] = 'sms-key';
      expect(() => guard.onModuleInit()).not.toThrow();

      process.env['GATEWAY_SECRET_KEY'] = 'live-key';
      expect(() => guard.onModuleInit()).toThrow(/GATEWAY_SECRET_KEY/);
      // The names reach a log; the values must not.
      expect(() => guard.onModuleInit()).not.toThrow(/live-key/);

      // A bot token is no longer graced: it has somewhere to live now.
      delete process.env['GATEWAY_SECRET_KEY'];
      process.env['TELEGRAM_BOT_TOKEN'] = '123:abc';
      expect(() => guard.onModuleInit()).toThrow(/TELEGRAM_BOT_TOKEN/);
    } finally {
      process.env = saved;
    }
  });
});

describe('F-1215 — every decryption writes an audit row', () => {
  const row = {
    id: 'cred-1',
    tenantId: 'tenant-1',
    kind: 'telegram_bot_token' as const,
    label: '',
    version: 3,
    status: TenantCredentialStatus.active,
    dekId: 'dek-1',
    iv: 'iv',
    authTag: 'tag',
    ciphertext: 'ct',
    fingerprint: 'fp',
    expiresAt: null,
    rotatedAt: null,
    lastUsedAt: null,
  };

  function vault(createAccess: jest.Mock) {
    const prisma = {
      tenantCredential: {
        findFirst: jest.fn().mockResolvedValue(row),
        update: jest.fn().mockResolvedValue(row),
      },
      tenantCredentialAccess: { create: createAccess },
    };
    const service = new CredentialVaultService(prisma as never, {} as never);
    // The DEK unwrap is KekService's job and is covered by vault.crypto.spec;
    // what this describe is about starts after the plaintext exists.
    jest
      .spyOn(service as never, 'dekKey')
      .mockResolvedValue(Buffer.alloc(32) as never);
    return { service, prisma };
  }

  it('records who, which tenant, which kind and which caller — never the value', async () => {
    const create = jest.fn().mockResolvedValue({});
    const { service } = vault(create);
    jest
      .spyOn(
        await import('./vault.crypto'),
        'open',
      )
      .mockReturnValue('the-secret');

    await service.use(
      { tenantId: 'tenant-1', kind: 'telegram_bot_token' },
      { caller: 'messenger:BotClientRegistry', actorId: 'admin-9' },
    );

    expect(create).toHaveBeenCalledTimes(1);
    const written = create.mock.calls[0][0].data;
    expect(written).toEqual({
      tenantId: 'tenant-1',
      credentialId: 'cred-1',
      kind: 'telegram_bot_token',
      label: '',
      version: 3,
      caller: 'messenger:BotClientRegistry',
      actorId: 'admin-9',
    });
    // Invariant #8, at the one seam that holds a plaintext.
    expect(JSON.stringify(written)).not.toContain('the-secret');
    expect(JSON.stringify(written)).not.toContain('fp');
  });

  it('fails the call when the row cannot be written', async () => {
    // An unaudited decryption is not one this service hands a value back for.
    // The opposite choice to `lastUsedAt`, which is fire-and-forget.
    const create = jest.fn().mockRejectedValue(new Error('audit table is down'));
    const { service } = vault(create);
    jest
      .spyOn(await import('./vault.crypto'), 'open')
      .mockReturnValue('the-secret');

    await expect(
      service.use(
        { tenantId: 'tenant-1', kind: 'telegram_bot_token' },
        { caller: 'messenger:BotClientRegistry' },
      ),
    ).rejects.toThrow('audit table is down');
  });
});
