import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Mocked } from 'vitest';
import { BotText } from '@txnet-backend/messenger';
import { aBotIntegration } from '@txnet-backend/messenger';
import { AuthApiClient } from '../auth-api/auth-api.client';
import { BillingApiClient } from '../billing-api/billing-api.client';
import type { MyService } from '../billing-api/services.types';
import { ChatContext } from '../conversation/nav.types';
import { BotKeys } from '../locale/bot-keys';
import { LocaleService } from '../locale/locale.service';
import { BotSessionStore } from '../session/bot-session.store';
import { ChatAccess } from '../session/chat-access';
import { SERVICE_STATUS_KEYS, ServicesFlow, serviceAction } from './services.flow';
import { ACTIONS } from './views';

/**
 * My services in the chat (F-307-y). The bot decides nothing: billing's list
 * says which services the user has and what state each is in. What would
 * break silently here:
 *  - **a service named by a raw key** — the buyer's label first, then the
 *    catalog's name in the chat's language, then the sku, never `catalog.x`;
 *  - **a status with no word** — every entitlement `GrantStatus` has one,
 *    read from the Prisma schema;
 *  - **a button that cannot be sent** — a callback is at most 64 bytes.
 */
const ctx: ChatContext = { integration: aBotIntegration(), platform: 'telegram', chatId: '5501', senderId: 42, lang: 'fa' };
const ok = <T>(data: T) => ({ ok: true, msg: 'ok', data });
const NOW = new Date('2026-10-15T12:00:00Z');
const ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const GB = 1024 ** 3;

const service = (over: Partial<MyService> = {}): MyService => ({
  id: ID,
  label: null,
  status: 'active',
  endsAt: '2026-10-25T18:00:00.000Z',
  variant: { id: 'v-1', sku: 'GOLD-30', nameKey: 'catalog.variant.gold30' },
  billingMode: 'prepaid',
  consumedBytes: String(3 * GB),
  trafficUnlimited: false,
  trafficCapBytes: String(50 * GB),
  frozen: false,
  frozenUntil: null,
  freezeMode: null,
  userMayUnfreeze: false,
  ...over,
});

const page = (rows: MyService[], total = rows.length) => ok({ total, page: 1, pageSize: 10, hidden: 0, rows });

function harness(list: unknown = page([service()])) {
  const auth = {
    refresh: vi.fn().mockResolvedValue(ok({ accessToken: 'access-1', expiresIn: 900, refreshToken: 'r-next' })),
  } as unknown as Mocked<AuthApiClient>;
  const billing = { myServices: vi.fn().mockResolvedValue(list) } as unknown as Mocked<BillingApiClient>;
  const sessions = { get: vi.fn().mockResolvedValue({ refreshToken: 'r-1', signedInAt: 0 }), save: vi.fn(), clear: vi.fn() } as unknown as BotSessionStore;
  const catalog: Record<string, Record<string, string>> = { fa: { 'variant.gold30': 'طلایی ۳۰ روزه' }, en: { 'variant.gold30': 'Gold 30 days', 'variant.onlyEn': 'English only' } };
  const locale = {
    getKey: vi.fn((lang: string, ns: string, key: string) => (ns === 'catalog' ? catalog[lang]?.[key] : undefined)),
    getDefaultLanguage: () => 'en',
  } as unknown as LocaleService;
  return { billing, flow: new ServicesFlow(billing, new ChatAccess(auth, sessions), locale, () => NOW) };
}

const ids = (r: { view: { actions?: { id: string }[][] } }) => (r.view.actions ?? []).flat().map((a) => a.id);
const labels = (r: { view: { actions?: { label: BotText }[][] } }) => (r.view.actions ?? []).flat().map((a) => a.label);
const valuesOf = (r: { view: { body: BotText } }) => r.view.body.values ?? {};

describe('the words', () => {
  it('names every GrantStatus entitlement has', () => {
    const schema = readFileSync(join(__dirname, '../../../../prisma/domains/entitlement.prisma'), 'utf8');
    const m = /enum GrantStatus \{([^}]*)\}/.exec(schema);
    if (!m) throw new Error('GrantStatus is no longer a Prisma enum — this test is stale');
    const statuses = [...m[1].matchAll(/^[ \t]*([a-z_]+)[ \t]*$/gm)].map((x) => x[1]).sort();
    expect(Object.keys(SERVICE_STATUS_KEYS).sort()).toEqual(statuses);
  });

  it('keeps a service button under the 64-byte callback cap', () => {
    expect(Buffer.byteLength(serviceAction('open', ID))).toBeLessThanOrEqual(64);
  });
});

describe('the list', () => {
  it('is one button per service, named and with its status', async () => {
    const { flow, billing } = harness(page([service(), service({ id: 'g-2', label: 'Phone', status: 'expired' })]));
    const r = await flow.start(ctx);
    expect(billing.myServices).toHaveBeenCalledWith(10, expect.objectContaining({ accessToken: 'access-1', lang: 'fa' }));
    expect(ids(r)).toEqual([serviceAction('open', ID), serviceAction('open', 'g-2')]);
    const [first, second] = labels(r);
    expect(first.values?.name).toEqual({ raw: 'طلایی ۳۰ روزه' });
    expect(first.values?.status).toEqual({ key: BotKeys.services.status.active });
    expect(second.values?.name).toEqual({ raw: 'Phone' });
    expect(second.values?.status).toEqual({ key: BotKeys.services.status.expired });
    expect(r.nextState).toBeNull();
  });

  it('names a frozen service frozen, not suspended', async () => {
    const { flow } = harness(page([service({ status: 'suspended', frozen: true, freezeMode: 'self' })]));
    expect(labels(await flow.start(ctx))[0].values?.status).toEqual({ key: BotKeys.services.frozen });
  });

  it('falls back to the default language, then the sku, then a plain word — never a raw key', async () => {
    const { flow } = harness(
      page([
        service({ id: 'a', variant: { id: 'v', sku: 'EN-1', nameKey: 'catalog.variant.onlyEn' } }),
        service({ id: 'b', variant: { id: 'v', sku: 'NO-NAME', nameKey: 'catalog.variant.missing' } }),
        service({ id: 'c', variant: null }),
      ]),
    );
    const names = labels(await flow.start(ctx)).map((l) => l.values?.name);
    expect(names).toEqual([{ raw: 'English only' }, { raw: 'NO-NAME' }, { key: BotKeys.services.unnamed }]);
  });

  it('says how many more there are than it shows', async () => {
    const { flow } = harness(page([service()], 14));
    const r = await flow.start(ctx);
    expect(valuesOf(r).more).toEqual({ key: BotKeys.services.more, values: { n: 13 } });
  });

  it('says there are none', async () => {
    const { flow } = harness(page([]));
    expect((await flow.start(ctx)).view.body).toEqual({ key: BotKeys.services.none });
  });

  it("tells billing's refusal as billing worded it", async () => {
    const { flow } = harness({ ok: false, msg: 'Not available' });
    expect((await flow.start(ctx)).view.body).toEqual({ raw: 'Not available' });
  });
});

describe('a service', () => {
  it('shows its status, its traffic against its cap and the days left, with the way back', async () => {
    const { flow } = harness();
    const r = await flow.tap(ctx, serviceAction('open', ID));
    expect(r.view.body.key).toBe(BotKeys.services.card);
    expect(valuesOf(r)).toMatchObject({
      name: { raw: 'طلایی ۳۰ روزه' },
      status: { key: BotKeys.services.status.active },
      traffic: { key: BotKeys.services.traffic.capped, values: { used: '3.0 GB', cap: '50 GB' } },
      time: { key: BotKeys.services.time.left, values: { d: 10 } },
    });
    expect(ids(r)).toEqual([ACTIONS.services]);
  });

  it('says unlimited, pay as you go, ended and no end date in their own words', async () => {
    const card = async (over: Partial<MyService>) => valuesOf(await harness(page([service(over)])).flow.tap(ctx, serviceAction('open', ID)));
    expect((await card({ trafficUnlimited: true, trafficCapBytes: null })).traffic).toEqual({ key: BotKeys.services.traffic.unlimited, values: { used: '3.0 GB' } });
    expect((await card({ billingMode: 'metered', trafficCapBytes: null, consumedBytes: '0' })).traffic).toEqual({ key: BotKeys.services.traffic.metered, values: { used: '0 MB' } });
    expect((await card({ endsAt: '2026-10-15T11:00:00.000Z' })).time).toEqual({ key: BotKeys.services.time.ended });
    expect((await card({ endsAt: '2026-10-15T20:00:00.000Z' })).time).toEqual({ key: BotKeys.services.time.today });
    expect((await card({ endsAt: null })).time).toEqual({ key: BotKeys.services.time.permanent });
  });

  it('says a service no longer listed is gone, and offers the list', async () => {
    const { flow } = harness(page([]));
    const r = await flow.tap(ctx, serviceAction('open', ID));
    expect(r.view.body).toEqual({ key: BotKeys.services.gone });
    expect(ids(r)).toEqual([ACTIONS.services]);
  });

  it('opens the list for a button it cannot read', async () => {
    const { flow, billing } = harness();
    await flow.tap(ctx, 'svc:zz');
    expect(billing.myServices).toHaveBeenCalledWith(10, expect.anything());
  });
});
