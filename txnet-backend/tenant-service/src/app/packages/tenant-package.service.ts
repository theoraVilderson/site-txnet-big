import { Injectable, Logger } from '@nestjs/common';
import { AdminAction, Prisma, TenantBillingModel, TenantStatus } from '@prisma/client';
import { platformCurrencyOf, inCurrency, type ItemTexts } from '@txnet-backend/shared-core';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { packageAudit, platformOwnerOnly, type TenantPackageActor } from './package-admin';
import { checkPackageParts, writePackageParts } from './package-parts';
import { addPackageEntitlements, lockPackage, lockSubscribers, replacePackageEntitlements } from './package-entitlements';
import { type MeterRateView, ratesOf, unknownMeters, writeMeterRates } from './package-meter-rates';
import { PackageTextService, type PackageTextView, packageTextKey } from './package-texts';
import { TenantPackageRefused } from './tenant-package.refusal';
import type { CreatePackageInput, ListPackagesInput, MeterRateEdit, UpdatePackageInput } from './tenant-package.schema';

export { TenantPackageRefused, type TenantPackageRejection } from './tenant-package.refusal';
export type { TenantPackageActor } from './package-admin';

/**
 * The platform owner creates, edits, deactivates, lists and reads the
 * packages the platform sells resellers (F-018-d).
 *
 * **Only the platform owner**, checked before any package row is read.
 * `tenant_feature_package` has no `tenantId` and no RLS policy, so the app pool
 * serves it; the audit row carries the platform owner's own tenant.
 *
 * **Never deleted.** Deactivation is `isActive: false` and writes nothing else:
 * a package's current subscribers keep it until their next renewal (F-019-c
 * decides what a renewal on an inactive package does). Prices are
 * base-currency decimals (C-02); a package keeps at least one of its two.
 *
 * **Subscribers follow a feature change halfway (F-018-o).** A key added to
 * `includedFeatureKeys` is granted to every current subscriber in the edit's
 * transaction; a removed key stays until that subscriber's renewal (F-019-c),
 * because the period was paid for with it. {@link apply} forces the full list,
 * removals included, onto every subscriber at once. Both run on the
 * cross-tenant pool — the entitlements are the subscribers' rows.
 *
 * **The wholesale price list rides along (F-118-n1).** `meterRates` writes
 * `tenant_package_meter_rate` in the same transaction as the package and its
 * audit row (`package-meter-rates.ts`); the view shows the rates in force.
 *
 * **Name and description are locale-service text (ADR-0154 decision 5).** The
 * source language is published as written as the transaction's last step, so a
 * locale-service that does not answer rolls the write back; the other languages
 * are drafted after the commit (`package-texts.ts`). `name` stays the source text.
 */


export type PackageApplyView = { packageId: string; includedFeatureKeys: string[]; subscribers: number };

export type PackageView = PackageTextView & {
  id: string;
  name: string;
  monthlyPrice: string | null;
  yearlyPrice: string | null;
  /** What both prices are in: the package's own, the platform's (ADR-0098 part 4, F-116-h3). */
  currencyCode: string;
  includedFeatureKeys: string[];
  isActive: boolean;
  /** The wholesale rates in force, by meter key (F-118-n1), in `currencyCode`. */
  meterRates: MeterRateView[];
  /** The platform products it lists (`package_product`); 0 sells nothing (ADR-0107 point 3, ADR-0154 (8)). */
  productCount: number;
};

/** `currencyCode`, once every price given is at its places (F-116-r) — refused otherwise. */
const pricesFit = (tx: Prisma.TransactionClient, currencyCode: string, prices: ReadonlyArray<string | null | undefined>) =>
  inCurrency(tx, currencyCode, { price: prices.filter((p): p is string => typeof p === 'string').map((p) => new Prisma.Decimal(p)) }, () => new TenantPackageRefused('package_price_finer_than_currency', currencyCode));

const PACKAGE_SELECT = {
  id: true,
  name: true,
  sourceLang: true,
  monthlyPrice: true,
  yearlyPrice: true,
  currencyCode: true,
  includedFeatureKeys: true,
  isActive: true,
} satisfies Prisma.TenantFeaturePackageSelect;

type PackageRow = Prisma.TenantFeaturePackageGetPayload<{ select: typeof PACKAGE_SELECT }>;

@Injectable()
export class TenantPackageService {
  private readonly logger = new Logger(TenantPackageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly all: CrossTenantPrismaService,
    private readonly texts: PackageTextService,
  ) {}

  /** The package and, when given, its limits, overage modes and products — all in one transaction, or none (ADR-0154 decision 4). */
  async create(actor: TenantPackageActor, input: CreatePackageInput): Promise<PackageView> {
    await platformOwnerOnly(this.prisma, actor);
    await this.nameFree(input.name);
    checkPackageParts(input);
    const sourceLang = this.texts.sourceOf(input.sourceLang);
    // The cross-tenant pool, as `update` and `apply`: RLS refuses this audit row on the app pool.
    const view = await this.writing(input.name, () =>
      this.all.$transaction(async (tx) => {
        await this.metersKnown(tx, input.meterRates ?? []);
        const row = await tx.tenantFeaturePackage.create({
          data: {
            name: input.name,
            sourceLang,
            monthlyPrice: input.monthlyPrice ?? null,
            yearlyPrice: input.yearlyPrice ?? null,
            includedFeatureKeys: input.includedFeatureKeys,
            // Priced in the platform's currency (ADR-0098 part 4); converted with it (F-116-f).
            currencyCode: await pricesFit(tx, await platformCurrencyOf(tx), [input.monthlyPrice, input.yearlyPrice]),
          },
          select: PACKAGE_SELECT,
        });
        await writeMeterRates(tx, row, [], input.meterRates ?? [], actor.adminId);
        await writePackageParts(tx, row, { input, adminId: actor.adminId });
        // Its text is published below, so the view cannot ask locale-service whether it has a description yet.
        const created = { ...this.view(row, await this.partsOne(tx, row)), descriptionKey: input.description ? packageTextKey(row.id, 'description') : null };
        const parts = { limits: input.limits ?? [], quotaOverages: input.quotaOverages ?? [], products: input.products ?? [] };
        await tx.adminAuditLog.create({
          data: packageAudit(actor, AdminAction.tenant_package_create, created.id, null, { ...created, description: input.description ?? null, ...parts }),
        });
        await this.texts.publishSources(sourceTexts(created.id, sourceLang, input));
        return created;
      }),
    );
    void this.texts.draftOthers(draftsOf(sourceTexts(view.id, sourceLang, input), sourceLang));
    this.logger.log(`package ${view.id} (${view.name}) created by ${actor.adminId}`);
    return view;
  }

  /**
   * A price cleared while a subscriber that is not terminated renews on that
   * period is `package_price_in_use` (F-019-c): the renewal would have nothing
   * to charge. Checked under the package's `FOR UPDATE`, which a subscription
   * `PUT` waits on.
   */
  private async pricesStillSold(tx: Prisma.TransactionClient, id: string, before: PackageView, patch: UpdatePackageInput): Promise<void> {
    const cleared: TenantBillingModel[] = [];
    if (patch.monthlyPrice === null && before.monthlyPrice !== null) cleared.push(TenantBillingModel.subscription_monthly);
    if (patch.yearlyPrice === null && before.yearlyPrice !== null) cleared.push(TenantBillingModel.subscription_yearly);
    if (cleared.length === 0) return;
    const inUse = await tx.tenantSubscription.count({
      where: { packageId: id, tenant: { billingModel: { in: cleared }, status: { not: TenantStatus.terminated } } },
    });
    if (inUse > 0) throw new TenantPackageRefused('package_price_in_use', `${inUse} subscriber(s) on ${cleared.join(', ')}`);
  }

  async update(actor: TenantPackageActor, id: string, patch: UpdatePackageInput): Promise<PackageView> {
    await platformOwnerOnly(this.prisma, actor);
    const found = await this.find(id);
    const before = this.view(found, await this.partsOne(this.prisma, found));
    const monthly = patch.monthlyPrice === undefined ? before.monthlyPrice : patch.monthlyPrice;
    const yearly = patch.yearlyPrice === undefined ? before.yearlyPrice : patch.yearlyPrice;
    if (monthly === null && yearly === null) throw new TenantPackageRefused('package_unpriced', id);
    if (patch.name !== undefined && patch.name !== before.name) await this.nameFree(patch.name);

    const data: Prisma.TenantFeaturePackageUpdateInput = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.monthlyPrice !== undefined) data.monthlyPrice = patch.monthlyPrice;
    if (patch.yearlyPrice !== undefined) data.yearlyPrice = patch.yearlyPrice;
    if (patch.includedFeatureKeys !== undefined) data.includedFeatureKeys = patch.includedFeatureKeys;
    if (patch.isActive !== undefined) data.isActive = patch.isActive;
    const retexted = patch.name !== undefined || patch.description !== undefined;
    const sourceLang = retexted ? this.texts.sourceOf(patch.sourceLang ?? found.sourceLang) : before.sourceLang;
    if (patch.sourceLang !== undefined) data.sourceLang = sourceLang;
    const publish = sourceTexts(id, sourceLang, patch);

    const view = await this.writing(patch.name ?? before.name, () =>
      this.all.$transaction(async (tx) => {
        await lockPackage(tx, id, 'update');
        await pricesFit(tx, before.currencyCode, [patch.monthlyPrice, patch.yearlyPrice]);
        await this.pricesStillSold(tx, id, before, patch);
        await this.metersKnown(tx, patch.meterRates ?? []);
        const held = patch.includedFeatureKeys === undefined ? null : await tx.tenantFeaturePackage.findUnique({ where: { id }, select: { includedFeatureKeys: true } });
        const row = await tx.tenantFeaturePackage.update({ where: { id }, data, select: PACKAGE_SELECT });
        const repriced = await writeMeterRates(tx, row, before.meterRates, patch.meterRates ?? [], actor.adminId);
        const descriptionKey = patch.description === undefined ? before.descriptionKey : patch.description && packageTextKey(id, 'description');
        const after = { ...this.view(row, await this.partsOne(tx, row)), descriptionKey };
        if (held) {
          const had = new Set(held.includedFeatureKeys as string[]);
          const added = after.includedFeatureKeys.filter((k) => !had.has(k));
          if (added.length > 0) await addPackageEntitlements(tx, await lockSubscribers(tx, id), added);
        }
        const changed = Object.keys(data) as (keyof PackageView)[];
        if (repriced) changed.push('meterRates');
        await tx.adminAuditLog.create({
          data: packageAudit(actor, AdminAction.tenant_package_update, id, pick(before, changed), {
            ...pick(after, changed),
            ...(patch.description === undefined ? {} : { description: patch.description }),
          }),
        });
        await this.texts.publishSources(publish);
        if (patch.description === null) await this.texts.clear([packageTextKey(id, 'description')]);
        return after;
      }),
    );
    void this.texts.draftOthers(draftsOf(publish, sourceLang));
    return view;
  }

  /** Every subscriber's `package_included` entitlements become the package's list now, removals included. */
  async apply(actor: TenantPackageActor, id: string): Promise<PackageApplyView> {
    await platformOwnerOnly(this.prisma, actor);
    await this.find(id);
    const view = await this.all.$transaction(async (tx) => {
      await lockPackage(tx, id, 'share');
      const row = await tx.tenantFeaturePackage.findUnique({ where: { id }, select: { includedFeatureKeys: true } });
      if (!row) throw new TenantPackageRefused('package_not_found', id);
      const includedFeatureKeys = row.includedFeatureKeys as string[];
      const subscribers = await lockSubscribers(tx, id);
      await replacePackageEntitlements(tx, subscribers, includedFeatureKeys);
      const result = { packageId: id, includedFeatureKeys, subscribers: subscribers.length };
      await tx.adminAuditLog.create({
        data: packageAudit(actor, AdminAction.tenant_package_apply, id, null, { includedFeatureKeys, subscribers: subscribers.length, tenantIds: subscribers }),
      });
      return result;
    });
    this.logger.log(`package ${id} forced onto ${view.subscribers} subscriber(s) by ${actor.adminId}`);
    return view;
  }

  async list(actor: TenantPackageActor, query: ListPackagesInput): Promise<PackageView[]> {
    await platformOwnerOnly(this.prisma, actor);
    const rows = await this.prisma.tenantFeaturePackage.findMany({
      where: query.active === undefined ? {} : { isActive: query.active },
      orderBy: { name: 'asc' },
      select: PACKAGE_SELECT,
    });
    const [rates, counts] = await Promise.all([ratesOf(this.prisma, rows), productCountsOf(this.prisma, rows)]);
    return rows.map((row) => this.view(row, { meterRates: rates.get(row.id) ?? [], productCount: counts.get(row.id) ?? 0 }));
  }

  async read(actor: TenantPackageActor, id: string): Promise<PackageView> {
    await platformOwnerOnly(this.prisma, actor);
    const row = await this.find(id);
    return this.view(row, await this.partsOne(this.prisma, row));
  }

  private view(row: PackageRow, parts: ViewParts): PackageView {
    return toView(row, parts, this.texts.viewOf(row.id, row.sourceLang));
  }

  private async find(id: string): Promise<PackageRow> {
    const row = await this.prisma.tenantFeaturePackage.findUnique({ where: { id }, select: PACKAGE_SELECT });
    if (!row) throw new TenantPackageRefused('package_not_found', id);
    return row;
  }

  private async partsOne(db: Pick<Prisma.TransactionClient, 'tenantPackageMeterRate' | 'packageProduct'>, row: PackageRow): Promise<ViewParts> {
    const [rates, counts] = await Promise.all([ratesOf(db, [row]), productCountsOf(db, [row])]);
    return { meterRates: rates.get(row.id) ?? [], productCount: counts.get(row.id) ?? 0 };
  }

  /** A rate for a meter the catalog does not have is refused before anything is written (the FK would say it as a 500). */
  private async metersKnown(tx: Prisma.TransactionClient, edits: MeterRateEdit[]): Promise<void> {
    const unknown = await unknownMeters(tx, edits);
    if (unknown.length > 0) throw new TenantPackageRefused('meter_not_found', unknown.join(', '));
  }

  private async nameFree(name: string): Promise<void> {
    const taken = await this.prisma.tenantFeaturePackage.findUnique({ where: { name }, select: { id: true } });
    if (taken) throw new TenantPackageRefused('package_name_taken', name);
  }

  /** A race past {@link nameFree} meets the unique index and gets the same refusal. */
  private async writing<T>(name: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      if ((e as { code?: string })?.code === 'P2002') throw new TenantPackageRefused('package_name_taken', name);
      throw e;
    }
  }
}

/** What a view reads beside the package row: its rates and how many products it lists. */
type ViewParts = Pick<PackageView, 'meterRates' | 'productCount'>;

/** How many platform products each package lists, one grouped read for the page. */
async function productCountsOf(db: Pick<Prisma.TransactionClient, 'packageProduct'>, rows: readonly { id: string }[]): Promise<Map<string, number>> {
  if (rows.length === 0) return new Map();
  const counts = await db.packageProduct.groupBy({ by: ['packageId'], where: { packageId: { in: rows.map((r) => r.id) } }, _count: { _all: true } });
  return new Map(counts.map((c) => [c.packageId, c._count._all]));
}

function toView(row: PackageRow, { meterRates, productCount }: ViewParts, texts: PackageTextView): PackageView {
  return {
    id: row.id,
    name: row.name,
    ...texts,
    monthlyPrice: row.monthlyPrice?.toString() ?? null,
    yearlyPrice: row.yearlyPrice?.toString() ?? null,
    currencyCode: row.currencyCode,
    includedFeatureKeys: row.includedFeatureKeys as string[],
    isActive: row.isActive,
    meterRates,
    productCount,
  };
}

function pick(view: PackageView, keys: (keyof PackageView)[]): Partial<PackageView> {
  return Object.fromEntries(keys.map((k) => [k, view[k]]));
}

/** The source-language texts a create or edit publishes: the name and a description given. */
function sourceTexts(id: string, lang: string, input: { name?: string; description?: string | null }): { key: string; text: ItemTexts }[] {
  const texts = [];
  if (input.name !== undefined) texts.push({ key: packageTextKey(id, 'name'), text: { [lang]: input.name } });
  if (input.description) texts.push({ key: packageTextKey(id, 'description'), text: { [lang]: input.description } });
  return texts;
}

/** Every other language is drafted from the source (ADR-0154 decision 5). */
function draftsOf(texts: { key: string; text: ItemTexts }[], from: string) {
  return texts.map(({ key, text }) => ({ key, from, text: text[from], written: [from] }));
}
