import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainVerificationStatus, Language, Prisma, TenantDomainPurpose, TenantDomainType } from '@prisma/client';
import {
  ObjectNotFound,
  ObjectRejected,
  ObjectStorage,
  type RejectReason,
  type TenantCapabilityName,
  type UploadPolicy,
  objectKey,
  panelHostOf,
  runWithTenant,
  ResellerAccess,
  ResellerAccessRefused,
  ResellerAccessRejection,
  ResellerActor,
} from '@txnet-backend/shared-core';

import type { EnvConfig } from '../config/env.validation';
import { FILES_PATH } from '../files/files.controller';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import type { BrandingSlot, UpdateBrandingInput } from './tenant-branding.schema';

/**
 * A reseller's branding (F-018-h, catalog 13.8, D-42 (3)).
 *
 * **Keys, not URLs.** Each image is stored through the object-storage port at
 * `branding/<slot>` in the reseller's own prefix, and the row keeps the key. A
 * URL is built on every read from the reseller's current domain (object-storage
 * rule 2): a proven `assets` domain, else a proven `panel` domain — for a
 * reseller only its own custom domain, since its platform subdomain serves
 * nothing (`panelHostOf`, F-018-aj). A domain that rotates moves every logo with
 * it and rewrites no row.
 *
 * **Who.** {@link ResellerAccess}, as for its domains (F-061-h): the path's
 * reseller, by its owner — judged by that reseller's status — or the platform
 * owner's staff. The row is then read on the cross-tenant pool, since it is not
 * the caller's tenant's, and the bytes are written in the **reseller's** scope,
 * so `stored_object`'s RLS binds them to it.
 *
 * The public read ({@link ofTenant}) has no caller at all: its tenant is the one
 * `FileHostMiddleware` resolved from the Host.
 */

export type BrandingActor = ResellerActor;

/** What a panel or landing page renders. Strings are data: the renderer escapes them (rule 3). */
export type BrandingView = {
  brandName: string;
  logoLightUrl: string | null;
  logoDarkUrl: string | null;
  faviconUrl: string | null;
  ogImageUrl: string | null;
  primaryColorHex: string | null;
  secondaryColorHex: string | null;
  supportEmail: string | null;
  supportPhone: string | null;
  supportUrl: string | null;
  socials: Record<string, string>;
  aboutText: string | null;
  termsUrl: string | null;
  privacyUrl: string | null;
  defaultLanguage: Language;
  updatedAt: Date | null;
};

/** An upload as the controller received it. */
export type UploadedAsset = { buffer: Buffer; mimetype: string };

export type BrandingRejection = ResellerAccessRejection | Exclude<RejectReason, 'bad_path'>;

export class BrandingRefused extends Error {
  constructor(
    readonly reason: BrandingRejection,
    detail = '',
  ) {
    super(`branding refused: ${reason}${detail ? ` (${detail})` : ''}`);
    this.name = 'BrandingRefused';
  }
}

type KeyColumn = 'logoLightKey' | 'logoDarkKey' | 'faviconKey' | 'ogImageKey';

/** Which column holds each slot's key. A new slot does not compile until it has one. */
const COLUMN: Record<BrandingSlot, KeyColumn> = {
  'logo-light': 'logoLightKey',
  'logo-dark': 'logoDarkKey',
  favicon: 'faviconKey',
  'og-image': 'ogImageKey',
};

const KB = 1024;

/**
 * PNG or WebP, never SVG (catalog 13.8) — and not JPEG either, which the port
 * allows: a logo needs transparency. Caps sized to what each slot is for.
 */
const IMAGE = ['image/png', 'image/webp'] as const;
export const BRANDING_POLICY: Record<BrandingSlot, UploadPolicy> = {
  'logo-light': { types: IMAGE, maxBytes: 512 * KB },
  'logo-dark': { types: IMAGE, maxBytes: 512 * KB },
  favicon: { types: IMAGE, maxBytes: 128 * KB },
  'og-image': { types: IMAGE, maxBytes: 1024 * KB },
};

/** The largest cap, for the multipart parser's own limit in front of the policy. */
export const BRANDING_MAX_BYTES = Math.max(...Object.values(BRANDING_POLICY).map((p) => p.maxBytes));

/** The doors a branding image is served from, in order of preference (object-storage rule 2). */
const ASSET_DOORS = [TenantDomainPurpose.assets, TenantDomainPurpose.panel] as const;

type BrandingRow = Prisma.TenantBrandingGetPayload<Record<string, never>>;

@Injectable()
export class TenantBrandingService {
  private readonly logger = new Logger(TenantBrandingService.name);

  constructor(
    private readonly resellerAccess: ResellerAccess,
    private readonly all: CrossTenantPrismaService,
    private readonly storage: ObjectStorage,
    private readonly config: ConfigService<EnvConfig, true>,
  ) {}

  async read(actor: BrandingActor, tenantId: string): Promise<BrandingView> {
    const reseller = await this.access(actor, tenantId, 'read');
    return this.view(reseller.id, reseller.slug);
  }

  /** The text, whole: a field left out is cleared. The images are untouched. */
  async update(actor: BrandingActor, tenantId: string, input: UpdateBrandingInput): Promise<BrandingView> {
    const reseller = await this.access(actor, tenantId, 'staffWrite');
    const data = { ...input, brandName: input.brandName, socials: input.socials as Prisma.InputJsonObject };
    await this.all.tenantBranding.upsert({ where: { tenantId: reseller.id }, create: { tenantId: reseller.id, ...data }, update: data });
    this.logger.log(`branding of ${reseller.id} edited by ${actor.userId}`);
    return this.view(reseller.id, reseller.slug);
  }

  /** Store one image and point its slot at it. A refused file writes nothing. */
  async upload(actor: BrandingActor, tenantId: string, slot: BrandingSlot, file: UploadedAsset): Promise<BrandingView> {
    const reseller = await this.access(actor, tenantId, 'staffWrite');
    let key: string;
    try {
      ({ key } = await runWithTenant({ id: reseller.id }, () =>
        this.storage.put(BRANDING_POLICY[slot], `branding/${slot}`, file.buffer, file.mimetype),
      ));
    } catch (e) {
      if (e instanceof ObjectRejected && e.reason !== 'bad_path') throw new BrandingRefused(e.reason, slot);
      throw e;
    }
    // Bytes first, then the reference — the port's own order: a failure here
    // leaves an orphan the next upload overwrites, never a row with no file.
    await this.all.tenantBranding.upsert({
      where: { tenantId: reseller.id },
      // A first upload before any text: the slug stands in for the name until one is set.
      create: { tenantId: reseller.id, brandName: reseller.slug, [COLUMN[slot]]: key },
      update: { [COLUMN[slot]]: key },
    });
    this.logger.log(`branding ${slot} of ${reseller.id} uploaded by ${actor.userId}`);
    return this.view(reseller.id, reseller.slug);
  }

  /** Clear a slot: the reference first, then the file. Repeats safely. */
  async remove(actor: BrandingActor, tenantId: string, slot: BrandingSlot): Promise<BrandingView> {
    const reseller = await this.access(actor, tenantId, 'staffWrite');
    await this.all.tenantBranding.updateMany({ where: { tenantId: reseller.id }, data: { [COLUMN[slot]]: null } });
    await runWithTenant({ id: reseller.id }, async () => {
      try {
        await this.storage.delete(objectKey(reseller.id, `branding/${slot}`));
      } catch (e) {
        if (!(e instanceof ObjectNotFound)) throw e;
      }
    });
    return this.view(reseller.id, reseller.slug);
  }

  /** The public read: the tenant the Host resolved to, whoever asks. */
  async ofTenant(tenantId: string): Promise<BrandingView> {
    const tenant = await this.all.tenant.findUnique({ where: { id: tenantId }, select: { slug: true } });
    return this.view(tenantId, tenant?.slug ?? '');
  }

  private async view(tenantId: string, slug: string): Promise<BrandingView> {
    const [row, host] = await Promise.all([
      this.all.tenantBranding.findUnique({ where: { tenantId } }) as Promise<BrandingRow | null>,
      this.assetHost(tenantId),
    ]);
    const prefix = this.config.get('GLOBAL_PREFIX', { infer: true });
    const url = (key: string | null | undefined) => (key && host ? `https://${host}/${prefix}/${FILES_PATH}/${key}` : null);
    return {
      brandName: row?.brandName ?? slug,
      logoLightUrl: url(row?.logoLightKey),
      logoDarkUrl: url(row?.logoDarkKey),
      faviconUrl: url(row?.faviconKey),
      ogImageUrl: url(row?.ogImageKey),
      primaryColorHex: row?.primaryColorHex ?? null,
      secondaryColorHex: row?.secondaryColorHex ?? null,
      supportEmail: row?.supportEmail ?? null,
      supportPhone: row?.supportPhone ?? null,
      supportUrl: row?.supportUrl ?? null,
      socials: (row?.socials as Record<string, string> | undefined) ?? {},
      aboutText: row?.aboutText ?? null,
      termsUrl: row?.termsUrl ?? null,
      privacyUrl: row?.privacyUrl ?? null,
      defaultLanguage: row?.defaultLanguage ?? Language.fa,
      updatedAt: row?.updatedAt ?? null,
    };
  }

  /** The host `FileHostMiddleware` will serve this tenant's files on: a proven assets door, else a proven panel door. */
  private async assetHost(tenantId: string): Promise<string | null> {
    const rows = await this.all.tenantDomain.findMany({
      where: { tenantId, purpose: { in: [...ASSET_DOORS] } },
      select: { domainValue: true, domainType: true, purpose: true, verificationStatus: true },
    });
    const proven = rows.filter(
      (r) => r.domainType === TenantDomainType.subdomain || r.verificationStatus === DomainVerificationStatus.verified,
    );
    const owner = await this.all.tenant.findUnique({ where: { id: tenantId }, select: { tenantType: true } });
    if (!owner) return null;
    for (const door of ASSET_DOORS) {
      const host = panelHostOf(proven.filter((r) => r.purpose === door), owner.tenantType);
      if (host) return host;
    }
    return null;
  }

  private async access(actor: BrandingActor, tenantId: string, capability: TenantCapabilityName) {
    try {
      return await this.resellerAccess.admit(actor, tenantId, capability);
    } catch (e) {
      if (e instanceof ResellerAccessRefused) throw new BrandingRefused(e.reason, tenantId);
      throw e;
    }
  }
}
