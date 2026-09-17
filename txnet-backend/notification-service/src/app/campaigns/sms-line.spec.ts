/**
 * A reseller's own SMS line (F-035-i-a, D-38, invariant 10).
 *
 * What would break silently here, and nowhere else:
 *  - **own line, own users.** A reseller's line is its key and its number, so
 *    it carries only that reseller's campaign to that reseller's users. A row
 *    of its campaign for another tenant's user — or a platform-wide campaign —
 *    sent on it would show a stranger the reseller's number; sent on the
 *    platform's line it would cost the platform;
 *  - **`own_credentials` is the switch, not a key in the vault.** A tenant on
 *    `use_platform_sms`, or with its config inactive, has no own line even if a
 *    key was once written — that is F-035-i-b's metered line, not this one;
 *  - **a broken line stalls, never fails.** A key revoked after the draft, or a
 *    vault that does not read, leaves the rows `queued` for the operator,
 *    exactly as the platform line does;
 *  - **one read per tenant per run**, never one per row.
 */
import { CredentialUnavailable } from '@txnet-backend/shared-core';

import { SmsLineResolver, SmsLineSource } from './sms-line';

const OWNER = '11111111-1111-4111-8111-111111111111';
const RESELLER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

const config = (url = 'https://sms.example/api') => ({ get: (_k: string, fallback: unknown) => url || fallback }) as never;

function vault(keys: Record<string, string | undefined> = { [OWNER]: 'owner@pass', [RESELLER]: 'reseller@pass' }) {
  return {
    available: true,
    use: vi.fn(async (ref: { tenantId: string; kind: string }) => {
      const key = keys[ref.tenantId];
      if (!key) throw new CredentialUnavailable(ref as never, 'missing');
      return ref.kind === 'sms_api_key' ? key : `line-${ref.tenantId.slice(0, 1)}`;
    }),
    summary: vi.fn(async (ref: { tenantId: string }) =>
      keys[ref.tenantId] ? { status: 'active', expiresAt: null } : null,
    ),
  };
}

/** `tenant_sms_config` rows, as the cross-tenant pool returns them for a `where`. */
function db(rows: { tenantId: string; mode: string; isActive: boolean }[] = [{ tenantId: RESELLER, mode: 'own_credentials', isActive: true }]) {
  const matches = (where: { tenantId: { in: string[] } | string; mode: string; isActive: boolean }) =>
    rows.filter(
      (r) =>
        (typeof where.tenantId === 'string' ? r.tenantId === where.tenantId : where.tenantId.in.includes(r.tenantId)) &&
        r.mode === where.mode &&
        r.isActive === where.isActive,
    );
  return {
    tenantSmsConfig: {
      findMany: vi.fn(async ({ where }) => matches(where).map((r) => ({ tenantId: r.tenantId }))),
      findFirst: vi.fn(async ({ where }) => matches(where)[0] ?? null),
    },
  };
}

const line = (name: string) => ({ send: vi.fn(), name }) as never;

describe('SmsLineResolver.lineFor — invariant 10, own line, own users', () => {
  const resolver = new SmsLineResolver(line('platform'), new Map([[RESELLER, line('reseller')]]));

  it("puts the owner's campaign to its own users on the platform line", () => {
    expect(resolver.lineFor(OWNER, OWNER, OWNER)).toMatchObject({ kind: 'ready', line: { name: 'platform' } });
  });

  it("puts a reseller's campaign to its own users on its own line", () => {
    expect(resolver.lineFor(RESELLER, RESELLER, OWNER)).toMatchObject({ kind: 'ready', line: { name: 'reseller' } });
  });

  it("refuses every other pairing: another tenant's user, a platform-wide campaign, a reseller without a line", () => {
    expect(resolver.lineFor(RESELLER, OTHER, OWNER).kind).toBe('none');
    expect(resolver.lineFor(RESELLER, OWNER, OWNER).kind).toBe('none');
    expect(resolver.lineFor(OWNER, RESELLER, OWNER).kind).toBe('none');
    expect(resolver.lineFor(null, RESELLER, OWNER).kind).toBe('none');
    expect(resolver.lineFor(OTHER, OTHER, OWNER).kind).toBe('none');
  });

  it('stalls a configured line that could not be opened', () => {
    expect(new SmsLineResolver(null, new Map([[RESELLER, null]])).lineFor(RESELLER, RESELLER, OWNER).kind).toBe('stalled');
  });
});

describe('SmsLineSource.resolverFor — reseller lines (F-035-i-a)', () => {
  const provider = { sendSMS: vi.fn().mockResolvedValue({ ok: true, msg: 'sent', data: true }) };

  it("opens each own_credentials tenant's line from its own vault, once per run", async () => {
    const v = vault();
    const d = db();
    const factory = vi.fn(() => provider);
    const resolver = await new SmsLineSource(config(), v as never, d as never, factory).resolverFor(null, [RESELLER, RESELLER]);

    const answer = resolver.lineFor(RESELLER, RESELLER, OWNER);
    expect(answer.kind).toBe('ready');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith('https://sms.example/api', 'reseller@pass');
    expect(v.use).toHaveBeenCalledWith({ tenantId: RESELLER, kind: 'sms_api_key' }, { caller: 'notification:SmsLineSource' });
    expect(v.use).toHaveBeenCalledTimes(2);
    if (answer.kind === 'ready') await answer.line.send('+98912', 'hi');
    expect(provider.sendSMS).toHaveBeenCalledWith({ msg: 'hi', to: '+98912' }, 'line-2');
  });

  it('gives no line to a tenant on use_platform_sms, with an inactive config, or with none', async () => {
    for (const rows of [
      [{ tenantId: RESELLER, mode: 'use_platform_sms', isActive: true }],
      [{ tenantId: RESELLER, mode: 'own_credentials', isActive: false }],
      [],
    ]) {
      const v = vault();
      const resolver = await new SmsLineSource(config(), v as never, db(rows) as never, () => provider).resolverFor(null, [RESELLER]);
      expect(resolver.lineFor(RESELLER, RESELLER, OWNER).kind).toBe('none');
      expect(v.use).not.toHaveBeenCalled();
    }
  });

  it('stalls a configured line with no key, no URL, no KEK or an unreadable vault — and the others still open', async () => {
    const kind = async (source: SmsLineSource) => (await source.resolverFor(null, [RESELLER])).lineFor(RESELLER, RESELLER, OWNER).kind;

    expect(await kind(new SmsLineSource(config(), vault({}) as never, db() as never, () => provider))).toBe('stalled');
    expect(await kind(new SmsLineSource(config(''), vault() as never, db() as never, () => provider))).toBe('stalled');
    expect(await kind(new SmsLineSource(config(), { ...vault(), available: false } as never, db() as never, () => provider))).toBe('stalled');

    const flaky = vault();
    flaky.use.mockImplementation(async (ref: { tenantId: string; kind: string }) => {
      if (ref.tenantId === RESELLER) throw new Error('connection reset');
      return ref.kind === 'sms_api_key' ? 'other@pass' : '4000';
    });
    const both = db([
      { tenantId: RESELLER, mode: 'own_credentials', isActive: true },
      { tenantId: OTHER, mode: 'own_credentials', isActive: true },
    ]);
    const resolver = await new SmsLineSource(config(), flaky as never, both as never, () => provider).resolverFor(null, [RESELLER, OTHER]);
    expect(resolver.lineFor(RESELLER, RESELLER, OWNER).kind).toBe('stalled');
    expect(resolver.lineFor(OTHER, OTHER, OWNER).kind).toBe('ready');
  });

  it("never treats the owner as a reseller: the owner's config does not open a second line", async () => {
    const d = db([{ tenantId: OWNER, mode: 'own_credentials', isActive: true }]);
    const resolver = await new SmsLineSource(config(), vault() as never, d as never, () => provider).resolverFor(OWNER, [OWNER]);
    expect(resolver.lineFor(OWNER, OWNER, OWNER).kind).toBe('ready');
    expect(resolver.lineFor(OWNER, RESELLER, OWNER).kind).toBe('none');
  });
});

describe('SmsLineSource.ownLineAvailable — the draft refusal (F-035-i-a)', () => {
  it('is true only for own_credentials, active, with a usable key — and decrypts nothing', async () => {
    const v = vault();
    expect(await new SmsLineSource(config(), v as never, db() as never).ownLineAvailable(RESELLER)).toBe(true);
    expect(v.use).not.toHaveBeenCalled();

    expect(await new SmsLineSource(config(), vault({}) as never, db() as never).ownLineAvailable(RESELLER)).toBe(false);
    const platformMode = db([{ tenantId: RESELLER, mode: 'use_platform_sms', isActive: true }]);
    expect(await new SmsLineSource(config(), vault() as never, platformMode as never).ownLineAvailable(RESELLER)).toBe(false);
    expect(await new SmsLineSource(config(), vault() as never, db() as never).ownLineAvailable(OTHER)).toBe(false);
  });
});
