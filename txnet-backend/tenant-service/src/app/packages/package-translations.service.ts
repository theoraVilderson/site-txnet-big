import { Injectable } from '@nestjs/common';
import { AdminAction } from '@prisma/client';
import type { ItemTextDraft } from '@txnet-backend/shared-core';

import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { packageAudit, platformOwnerOnly, type TenantPackageActor } from './package-admin';
import { PackageTextService, packageOfTextKey, packageTextKey } from './package-texts';
import { TenantPackageRefused } from './tenant-package.refusal';
import type { EditPackageTextsInput, PublishPackageTextsInput } from './tenant-package.schema';

/**
 * Reviewing the machine drafts of package names and descriptions (ADR-0154
 * decision 6): catalog's review, over the `packages` namespace and the platform
 * owner's packages, with catalog's answers — so the panel's `TranslationsView`
 * serves both through its surface.
 *
 * A key is published only when it is one `packageTextKey` derived for a package
 * that exists; each publish is audited on the packages whose text it changed.
 */
@Injectable()
export class PackageTranslationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly all: CrossTenantPrismaService,
    private readonly texts: PackageTextService,
  ) {}

  /** Drafts waiting for review, each beside its source text and what is published now. */
  async listTextDrafts(actor: TenantPackageActor, lang?: string): Promise<ItemTextDraft[]> {
    await platformOwnerOnly(this.prisma, actor);
    return this.texts.reviewList(await this.sources(), lang);
  }

  /**
   * "Translate missing". A package from before PK-1-c has no text at all, so its
   * `name` column is published as its source-language name and drafted from
   * directly: the client's copy of the namespace learns of that publish only
   * when locale-service pushes it, after this call (seen on dev, 2026-10-18).
   */
  async draftMissingTexts(actor: TenantPackageActor): Promise<{ drafted: number }> {
    await platformOwnerOnly(this.prisma, actor);
    const packages = await this.packages();
    const untexted = packages.filter((p) => !this.texts.hasSourceName(p.id, p.sourceLang));
    const names = untexted.map((p) => ({ key: packageTextKey(p.id, 'name'), from: p.sourceLang, text: p.name, written: [p.sourceLang] }));
    await this.texts.publishSources(names.map(({ key, from, text }) => ({ key, text: { [from]: text } })));
    const fresh = new Set(names.map((n) => n.key));
    const rest = [...(await this.sources(packages))].filter(([key]) => !fresh.has(key)).map(([key, from]) => ({ key, from }));
    return { drafted: (await this.texts.draftOthers(names)) + (await this.texts.draftMissing(rest)) };
  }

  /** Publishes drafts as they are. */
  async publishTextDrafts(actor: TenantPackageActor, input: PublishPackageTextsInput): Promise<{ published: number }> {
    return this.publishing(actor, input.lang, input.keys, { published: input.keys }, () => this.texts.publishDrafts(input.lang, input.keys));
  }

  /** Publishes a reviewer's own text for a language, in place of any draft. */
  async editTexts(actor: TenantPackageActor, input: EditPackageTextsInput): Promise<{ published: number }> {
    const keys = Object.keys(input.texts);
    return this.publishing(actor, input.lang, keys, { edited: input.texts }, () => this.texts.publishEdited(input.lang, input.texts));
  }

  private async publishing(
    actor: TenantPackageActor,
    lang: string,
    keys: string[],
    change: object,
    publish: () => Promise<number>,
  ): Promise<{ published: number }> {
    await platformOwnerOnly(this.prisma, actor);
    this.texts.sourceOf(lang); // `lang_unknown`, before locale-service answers it as an outage
    const known = new Set((await this.packages()).map((p) => p.id));
    const touched = new Set<string>();
    for (const key of keys) {
      const id = packageOfTextKey(key);
      if (!id || !known.has(id)) throw new TenantPackageRefused('text_key_invalid', key);
      touched.add(id);
    }
    const published = await publish();
    await this.all.adminAuditLog.createMany({
      data: [...touched].map((id) => packageAudit(actor, AdminAction.tenant_package_update, id, null, { texts: { lang, ...change } })),
    });
    return { published };
  }

  // Every package: the platform owns them all, and there are a handful (one per tier or deal).
  private async packages(): Promise<{ id: string; name: string; sourceLang: string }[]> {
    const rows = await this.prisma.tenantFeaturePackage.findMany({ select: { id: true, name: true, sourceLang: true } });
    return rows.map((r) => ({ ...r, sourceLang: r.sourceLang ?? this.texts.defaultLanguage() }));
  }

  /** Every package text key, with its package's source language. */
  private async sources(packages?: { id: string; sourceLang: string }[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const p of packages ?? (await this.packages())) {
      map.set(packageTextKey(p.id, 'name'), p.sourceLang);
      map.set(packageTextKey(p.id, 'description'), p.sourceLang);
    }
    return map;
  }
}
