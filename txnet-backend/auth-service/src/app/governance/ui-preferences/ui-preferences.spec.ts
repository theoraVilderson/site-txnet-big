import { BadRequestException } from '@nestjs/common';

import type { AuthClaims } from '../../auth/token.service';
import { UI_PREFERENCE_DEFAULTS, UI_PREFERENCE_MAX_BYTES } from './ui-preferences';
import { UiPreferencesService } from './ui-preferences.service';

/**
 * Display preferences (UX-1-k, `panel-web/contract.ux.md` P1–P3): four keys in
 * governance's `user_setting`, category `display`. A read answers every key
 * with defaults filled in; a write takes any subset, strictly, and touches only
 * the caller's own rows.
 */

const CLAIMS = { sub: 'user-1', tenantId: 'tenant-1' } as AuthClaims;

type Row = { key: string; value: unknown };

function harness(rows: Row[] = []) {
  const store = new Map(rows.map((r) => [r.key, r.value]));
  const upsert = vi.fn(async ({ where, create, update }: { where: { userId_key: { userId: string; key: string } }; create: Row; update: Row }) => {
    store.set(where.userId_key.key, update.value ?? create.value);
    return {};
  });
  const prisma = {
    userSetting: {
      findMany: vi.fn(async () => [...store].map(([key, value]) => ({ key, value }))),
      upsert,
    },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  return { prisma, service: new UiPreferencesService(prisma as never) };
}

async function refusal(run: () => Promise<unknown>) {
  const err = await run().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(BadRequestException);
  return (err as BadRequestException).getResponse() as { reason: string };
}

describe('UiPreferencesService', () => {
  it("reads every key with defaults filled in, from the caller's own rows only", async () => {
    const { service, prisma } = harness();
    const out = await service.read(CLAIMS);

    expect(out).toMatchObject({ ok: true, data: UI_PREFERENCE_DEFAULTS });
    expect(UI_PREFERENCE_DEFAULTS).toEqual({
      'ui.motion': 'system',
      'ui.dashboard': { order: [], hidden: [] },
      'ui.pins': [],
      'ui.sidebar': { collapsed: false, closedSections: [] },
    });
    expect(prisma.userSetting.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: 'user-1' }) }),
    );
  });

  it('answers a saved value, and a stored value that no longer fits its key reads as the default', async () => {
    const { service } = harness([
      { key: 'ui.motion', value: 'reduced' },
      { key: 'ui.pins', value: 'not-a-list' },
    ]);
    const out = await service.read(CLAIMS);

    expect(out.data['ui.motion']).toBe('reduced');
    expect(out.data['ui.pins']).toEqual([]);
  });

  it("writes only the keys sent, into the caller's own rows under `display`, and answers the whole set", async () => {
    const { service, prisma } = harness([{ key: 'ui.motion', value: 'full' }]);
    const out = await service.save(CLAIMS, { 'ui.pins': ['/wallet', '/support'] });

    expect(prisma.userSetting.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.userSetting.upsert).toHaveBeenCalledWith({
      where: { userId_key: { userId: 'user-1', key: 'ui.pins' } },
      create: { userId: 'user-1', key: 'ui.pins', category: 'display', value: ['/wallet', '/support'] },
      update: { value: ['/wallet', '/support'], category: 'display' },
    });
    expect(out).toMatchObject({ ok: true, data: { 'ui.motion': 'full', 'ui.pins': ['/wallet', '/support'] } });
  });

  it('refuses an unknown key as `unknown_preference` and writes nothing', async () => {
    const { service, prisma } = harness();
    const body = await refusal(() => service.save(CLAIMS, { 'ui.motion': 'full', 'ui.theme': 'dark' }));

    expect(body.reason).toBe('unknown_preference');
    expect(prisma.userSetting.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['a motion level that is not one', { 'ui.motion': 'fast' }],
    ['nine pins', { 'ui.pins': Array.from({ length: 9 }, (_, i) => `/p${i}`) }],
    ['a dashboard id over 40 characters', { 'ui.dashboard': { order: ['x'.repeat(41)], hidden: [] } }],
    ['31 dashboard ids', { 'ui.dashboard': { order: Array.from({ length: 31 }, (_, i) => `w${i}`), hidden: [] } }],
    ['a field the key does not have', { 'ui.sidebar': { collapsed: true, closedSections: [], width: 300 } }],
    ['a body that is not an object', ['ui.motion']],
  ])('refuses %s, strictly, and writes nothing', async (_name, patch) => {
    const { service, prisma } = harness();
    const body = await refusal(() => service.save(CLAIMS, patch));

    expect(body.reason).toBe('invalid_preference');
    expect(prisma.userSetting.upsert).not.toHaveBeenCalled();
  });

  it(`refuses a value over ${UI_PREFERENCE_MAX_BYTES} bytes as \`preference_too_large\``, async () => {
    const { service, prisma } = harness();
    // 30 + 30 ids of 40 three-byte characters each: inside every count, ~7 KB as JSON.
    const ids = Array.from({ length: 30 }, () => '字'.repeat(40));
    const body = await refusal(() => service.save(CLAIMS, { 'ui.dashboard': { order: ids, hidden: ids } }));

    expect(body.reason).toBe('preference_too_large');
    expect(prisma.userSetting.upsert).not.toHaveBeenCalled();
  });
});
