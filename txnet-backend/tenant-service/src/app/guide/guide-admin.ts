import { Injectable, Logger } from '@nestjs/common';
import { GuideKind, GuideSurface, GuideTargetKind, Language, Prisma } from '@prisma/client';
import {
  type GuideBlock,
  ObjectRejected,
  ObjectStorage,
  type RejectReason,
  type UploadPolicy,
  guideBlocksSchema,
  type GuideFileRole,
  guideFileRoles,
  guideSlotRefusal,
  parseObjectKey,
  platformTenantIdOf,
  runWithTenant,
  tenantTransaction,
  GUIDE_FILE_EXTENSIONS,
} from '@txnet-backend/shared-core';
import { randomUUID } from 'node:crypto';

import { PLATFORM_SHARED_PREFIXES } from '../files/files.controller';
import { PlatformTenant } from '../files/platform-tenant';
import { StorageQuota } from '../files/storage-quota';
import { CrossTenantPrismaService } from '../prisma/cross-tenant-prisma.service';
import { PrismaService } from '../prisma/prisma.service';
import { GuideGenerations, ResolvedGuide, pickTranslation } from './guide-reader';

/**
 * F-414-c — **writing guides** (ADR-0115, ADR-0116, ADR-0117), behind
 * `guide.manage`.
 *
 * **Whose.** The caller's tenant decides: the platform owner's admin writes the
 * platform's guides (`tenantId` NULL) — on the cross-tenant pool, since the app
 * pool's policy never lets a write name NULL — and a reseller's admin writes
 * its own on the app pool, RLS-bound to it. Every query names its owner
 * explicitly as well, so a reseller reading a platform row (RLS lets it read)
 * never mistakes it for its own: acting on one is `guide_unknown`.
 *
 * **Drafts** (ADR-0117 point 1). Every text written goes to `guide_draft`;
 * readers see only `guide_translation`. Publish replaces every published
 * language with the draft and deletes it. A reseller's override is created as a
 * draft holding the platform's text, so its users keep the platform's guide
 * until it publishes. Placements are live.
 *
 * **Cache.** A write a reader could see bumps its owner's generation
 * (F-414-b); a draft write does not.
 *
 * **Files.** An image is uploaded to `guides/<guideId>/<uuid>.<ext>` under the
 * owner's storage prefix (the platform's tenant for the platform), public. A
 * text may name only its owner's `guides/` files or the platform's — the ones
 * every Host serves (ADR-0117 point 2) — and only files that exist and are
 * public. Files are never deleted here: an override keeps naming the
 * platform's, so no single owner can tell a file is unused.
 */

export type GuideRejection =
  | 'guide_unknown'
  | 'guide_key_taken'
  | 'guide_invalid'
  | 'guide_slot'
  | 'guide_product_unknown'
  | 'guide_file'
  | 'guide_no_draft'
  | 'guide_not_inherited'
  | Exclude<RejectReason, 'bad_path'>;

export class GuideRefused extends Error {
  constructor(
    readonly reason: GuideRejection,
    detail = '',
  ) {
    super(`guide refused: ${reason}${detail ? ` (${detail})` : ''}`);
  }
}

export interface GuideActor {
  userId: string;
  tenantId: string;
  permissions: string[];
}

export type GuideState = 'draft' | 'published' | 'archived';

export interface GuideText {
  lang: Language;
  title: string;
  blocks: GuideBlock[];
}

export interface GuidePlacementInput {
  surface: GuideSurface;
  targetKind: GuideTargetKind;
  targetRef: string;
}

export interface GuideSummary {
  id: string;
  key: string;
  kind: GuideKind;
  sortOrder: number;
  /** `archived` when inactive, else `published` once a text is published, else `draft`. */
  state: GuideState;
  /** Unpublished edits exist. */
  hasDraft: boolean;
  publishedLangs: Language[];
  placements: GuidePlacementInput[];
  publishedAt: string | null;
  updatedAt: string;
}

export interface GuideDetail extends GuideSummary {
  owner: 'platform' | 'own';
  /** A platform guide seen by a reseller: read it, override or hide it, never edit it. */
  readOnly: boolean;
  published: GuideText[];
  /** Empty when nothing is unpublished, and always for a read-only guide. */
  draft: GuideText[];
}

export interface InheritedGuide {
  id: string;
  key: string;
  kind: GuideKind;
  /** In the caller's language, else the fallback order. */
  title: string;
  placements: GuidePlacementInput[];
  /** The reseller's own guide under this key, published or not. */
  overriddenBy: string | null;
  hidden: boolean;
}

export interface GuideList {
  /** Whose guides `own` are: the platform's (the platform owner's admin) or the caller tenant's. */
  owner: 'platform' | 'tenant';
  own: GuideSummary[];
  /** The platform's live guides as this reseller inherits them; empty for the platform. */
  inherited: InheritedGuide[];
}

export interface CreateGuideInput {
  key: string;
  kind: GuideKind;
  sortOrder?: number;
  texts: GuideText[];
  placements?: GuidePlacementInput[];
}

export interface GuidePreview extends ResolvedGuide {
  /** What was rendered: the draft when there is one, else the published text. */
  source: 'draft' | 'published';
}

export type UploadedGuideFile = { buffer: Buffer; mimetype: string };

const KB = 1024;
/** Screenshots, diagrams and a video's poster. */
export const GUIDE_IMAGE_POLICY: UploadPolicy = {
  types: ['image/png', 'image/webp', 'image/jpeg'],
  maxBytes: 2048 * KB,
  visibility: 'public',
};
/**
 * A how-to recording (F-414-i): what every browser and both messengers play.
 * Held in memory for the upload, as an image is; 50 MiB is Telegram's own
 * ceiling for a video a bot uploads, so the bot can send any guide video.
 */
export const GUIDE_VIDEO_POLICY: UploadPolicy = {
  types: ['video/mp4', 'video/webm'],
  maxBytes: 50 * KB * KB,
  visibility: 'public',
};

/** Why a stored file cannot play the role a block gives it, or `null` when it can (F-414-i). */
export function fileRoleRefusal(role: GuideFileRole, contentType: string): 'not a video' | 'not an image' | null {
  if (role === 'video') return GUIDE_VIDEO_POLICY.types.includes(contentType as never) ? null : 'not a video';
  return GUIDE_IMAGE_POLICY.types.includes(contentType as never) ? null : 'not an image';
}

const ORDER = [{ sortOrder: 'asc' as const }, { key: 'asc' as const }];
const WITH = {
  translations: { select: { lang: true, title: true, blocks: true } },
  drafts: { select: { lang: true, title: true, blocks: true } },
  placements: { select: { surface: true, targetKind: true, targetRef: true } },
} as const;
type GuideRow = Prisma.GuideGetPayload<{ include: typeof WITH }>;
type Tx = Prisma.TransactionClient;
/** `null` is the platform. */
type Owner = string | null;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

@Injectable()
export class GuideAdmin {
  private readonly logger = new Logger(GuideAdmin.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly all: CrossTenantPrismaService,
    private readonly storage: ObjectStorage,
    private readonly platform: PlatformTenant,
    private readonly generations: GuideGenerations,
    private readonly quota: StorageQuota,
  ) {}

  async list(actor: GuideActor, lang: string): Promise<GuideList> {
    const owner = await this.ownerOf(actor);
    return this.run(owner, async (tx) => {
      const own = await tx.guide.findMany({ where: { tenantId: owner }, include: WITH, orderBy: ORDER });
      if (owner === null) return { owner: 'platform', own: own.map(summaryOf), inherited: [] };
      const [platform, hidden] = await Promise.all([
        tx.guide.findMany({
          where: { tenantId: null, isActive: true, translations: { some: {} } },
          include: { translations: { select: { lang: true, title: true } }, placements: WITH.placements },
          orderBy: ORDER,
        }),
        tx.guideHidden.findMany({ where: { tenantId: owner }, select: { key: true } }),
      ]);
      const hiddenKeys = new Set(hidden.map((h) => h.key));
      return {
        owner: 'tenant',
        own: own.map(summaryOf),
        inherited: platform.map((p) => ({
          id: p.id,
          key: p.key,
          kind: p.kind,
          title: pickTranslation(p.translations, lang)?.title ?? p.key,
          placements: p.placements,
          overriddenBy: own.find((o) => o.key === p.key)?.id ?? null,
          hidden: hiddenKeys.has(p.key),
        })),
      };
    });
  }

  /** One own guide, or — to a reseller — one live platform guide, read-only and without its draft. */
  async get(actor: GuideActor, id: string): Promise<GuideDetail> {
    const owner = await this.ownerOf(actor);
    return this.run(owner, async (tx) => {
      const own = await tx.guide.findFirst({ where: { id, tenantId: owner }, include: WITH });
      if (own) return detailOf(own, owner === null ? 'platform' : 'own', false);
      if (owner !== null) {
        const inherited = await tx.guide.findFirst({ where: { id, tenantId: null, isActive: true, translations: { some: {} } }, include: WITH });
        if (inherited) return detailOf({ ...inherited, drafts: [] }, 'platform', true);
      }
      throw new GuideRefused('guide_unknown', id);
    });
  }

  /** A new guide, as a draft: nothing is shown until it is published. */
  async create(actor: GuideActor, input: CreateGuideInput): Promise<GuideDetail> {
    const owner = await this.ownerOf(actor);
    assertTexts(input.texts);
    await this.assertFiles(owner, input.texts);
    const id = randomUUID();
    return this.run(owner, async (tx) => {
      if (await tx.guide.findFirst({ where: { tenantId: owner, key: input.key }, select: { id: true } })) {
        throw new GuideRefused('guide_key_taken', input.key);
      }
      const placements = await this.checkPlacements(tx, owner, input.placements ?? []);
      const row = await tx.guide.create({
        data: {
          id,
          tenantId: owner,
          key: input.key,
          kind: input.kind,
          sortOrder: input.sortOrder ?? 0,
          drafts: { create: input.texts.map((t) => ({ tenantId: owner, lang: t.lang, title: t.title, blocks: t.blocks as Prisma.InputJsonValue })) },
          placements: { create: placements.map((p) => ({ tenantId: owner, ...p })) },
        },
        include: WITH,
      });
      this.logger.log(`guide ${row.key} (${row.id}) created for ${owner ?? 'the platform'} by ${actor.userId}`);
      return detailOf(row, owner === null ? 'platform' : 'own', false);
    });
  }

  /** Kind and order; the key never changes — it is what a reseller's copy and hide name. */
  async update(actor: GuideActor, id: string, input: { kind?: GuideKind; sortOrder?: number }): Promise<GuideDetail> {
    return this.write(actor, id, true, (tx) => tx.guide.update({ where: { id }, data: input, include: WITH }));
  }

  /** Replaces every language of the draft; the published text is untouched. */
  async saveDraft(actor: GuideActor, id: string, texts: GuideText[]): Promise<GuideDetail> {
    assertTexts(texts);
    const owner = await this.ownerOf(actor);
    await this.assertFiles(owner, texts);
    return this.write(actor, id, false, async (tx) => {
      await tx.guideDraft.deleteMany({ where: { guideId: id } });
      await tx.guideDraft.createMany({
        data: texts.map((t) => ({ guideId: id, tenantId: owner, lang: t.lang, title: t.title, blocks: t.blocks as Prisma.InputJsonValue })),
      });
      return tx.guide.update({ where: { id }, data: { updatedAt: new Date() }, include: WITH });
    });
  }

  async discardDraft(actor: GuideActor, id: string): Promise<GuideDetail> {
    return this.write(actor, id, false, async (tx) => {
      const { count } = await tx.guideDraft.deleteMany({ where: { guideId: id } });
      if (count === 0) throw new GuideRefused('guide_no_draft', id);
      return tx.guide.findUniqueOrThrow({ where: { id }, include: WITH });
    });
  }

  /** The draft as a reader would get it, else the published text; nothing is written. */
  async preview(actor: GuideActor, id: string, lang: string): Promise<GuidePreview> {
    const guide = await this.get(actor, id);
    const source = guide.draft.length > 0 ? 'draft' : 'published';
    const text = pickTranslation(source === 'draft' ? guide.draft : guide.published, lang);
    if (!text) throw new GuideRefused('guide_no_draft', id);
    return {
      id: guide.id,
      key: guide.key,
      kind: guide.kind,
      owner: guide.owner,
      lang: text.lang,
      title: text.title,
      blocks: text.blocks,
      sortOrder: guide.sortOrder,
      updatedAt: guide.updatedAt,
      source,
    };
  }

  /** Every published language becomes the draft's, in one transaction; the draft is gone. */
  async publish(actor: GuideActor, id: string): Promise<GuideDetail> {
    return this.write(actor, id, true, async (tx) => {
      const drafts = await tx.guideDraft.findMany({ where: { guideId: id } });
      if (drafts.length === 0) throw new GuideRefused('guide_no_draft', id);
      await tx.guideTranslation.deleteMany({ where: { guideId: id } });
      await tx.guideTranslation.createMany({
        data: drafts.map((d) => ({ guideId: id, tenantId: d.tenantId, lang: d.lang, title: d.title, blocks: d.blocks as Prisma.InputJsonValue })),
      });
      await tx.guideDraft.deleteMany({ where: { guideId: id } });
      return tx.guide.update({ where: { id }, data: { publishedAt: new Date() }, include: WITH });
    });
  }

  /** `true` archives (shown nowhere, kept), `false` restores. */
  async archive(actor: GuideActor, id: string, archived: boolean): Promise<GuideDetail> {
    return this.write(actor, id, true, (tx) => tx.guide.update({ where: { id }, data: { isActive: !archived }, include: WITH }));
  }

  /** Replaces every placement, each in a registered slot (invariant 5). */
  async setPlacements(actor: GuideActor, id: string, placements: GuidePlacementInput[]): Promise<GuideDetail> {
    const owner = await this.ownerOf(actor);
    return this.write(actor, id, true, async (tx) => {
      const checked = await this.checkPlacements(tx, owner, placements);
      await tx.guidePlacement.deleteMany({ where: { guideId: id } });
      await tx.guidePlacement.createMany({ data: checked.map((p) => ({ id: randomUUID(), guideId: id, tenantId: owner, ...p })) });
      return tx.guide.findUniqueOrThrow({ where: { id }, include: WITH });
    });
  }

  /** Deletes an own guide with its texts and placements. A reseller's copy gone, the platform's shows again. */
  async remove(actor: GuideActor, id: string): Promise<void> {
    await this.write(actor, id, true, async (tx) => {
      await tx.guide.delete({ where: { id } });
      return null;
    });
  }

  /**
   * A reseller's own copy of a platform guide under the same key: a draft
   * holding the platform's published text and its placements. Users keep the
   * platform's until the copy is published.
   */
  async override(actor: GuideActor, key: string): Promise<GuideDetail> {
    const owner = await this.ownerOf(actor);
    if (owner === null) throw new GuideRefused('guide_not_inherited', key);
    return this.run(owner, async (tx) => {
      const source = await tx.guide.findFirst({
        where: { tenantId: null, key, isActive: true, translations: { some: {} } },
        include: WITH,
      });
      if (!source) throw new GuideRefused('guide_not_inherited', key);
      if (await tx.guide.findFirst({ where: { tenantId: owner, key }, select: { id: true } })) {
        throw new GuideRefused('guide_key_taken', key);
      }
      const row = await tx.guide.create({
        data: {
          id: randomUUID(),
          tenantId: owner,
          key,
          kind: source.kind,
          sortOrder: source.sortOrder,
          drafts: {
            create: source.translations.map((t) => ({ tenantId: owner, lang: t.lang, title: t.title, blocks: t.blocks as Prisma.InputJsonValue })),
          },
          placements: { create: source.placements.map((p) => ({ tenantId: owner, ...p })) },
        },
        include: WITH,
      });
      this.logger.log(`guide ${key} overridden by ${owner} (${row.id}) by ${actor.userId}`);
      return detailOf(row, 'own', false);
    });
  }

  /** `true` hides a platform guide from this reseller's users, `false` shows it again. */
  async setHidden(actor: GuideActor, key: string, hidden: boolean): Promise<void> {
    const owner = await this.ownerOf(actor);
    if (owner === null) throw new GuideRefused('guide_not_inherited', key);
    await this.run(owner, async (tx) => {
      if (!(await tx.guide.findFirst({ where: { tenantId: null, key }, select: { id: true } }))) {
        throw new GuideRefused('guide_not_inherited', key);
      }
      if (hidden) {
        await tx.guideHidden.upsert({ where: { tenantId_key: { tenantId: owner, key } }, create: { tenantId: owner, key }, update: {} });
      } else {
        await tx.guideHidden.deleteMany({ where: { tenantId: owner, key } });
      }
    });
    await this.bump(owner);
  }

  /** An image for an own guide; returns its key for a block to name. */
  upload(actor: GuideActor, id: string, file: UploadedGuideFile): Promise<{ key: string }> {
    return this.store(actor, id, file, GUIDE_IMAGE_POLICY);
  }

  /**
   * A video for an own guide (F-414-i). Stored as an image is; served by the
   * media server, never by a Nest route (ADR-0116 point 3, ADR-0118).
   */
  uploadVideo(actor: GuideActor, id: string, file: UploadedGuideFile): Promise<{ key: string }> {
    return this.store(actor, id, file, GUIDE_VIDEO_POLICY);
  }

  private async store(actor: GuideActor, id: string, file: UploadedGuideFile, policy: UploadPolicy): Promise<{ key: string }> {
    const owner = await this.ownerOf(actor);
    await this.run(owner, async (tx) => {
      if (!(await tx.guide.findFirst({ where: { id, tenantId: owner }, select: { id: true } }))) throw new GuideRefused('guide_unknown', id);
    });
    const ext = (GUIDE_FILE_EXTENSIONS as Record<string, string>)[file.mimetype];
    if (!ext || !policy.types.includes(file.mimetype as never)) throw new GuideRefused('type_not_allowed', file.mimetype);
    const storageTenant = owner ?? (await this.platform.id());
    const path = `guides/${id}/${randomUUID()}.${ext}`;
    try {
      // F-414-m: a reseller's files are held to `storage_mib_max`; the platform's tenant is exempt.
      const { key } = await runWithTenant({ id: storageTenant }, async () => {
        await this.quota.assertRoom(path, file.buffer.length);
        return this.storage.put(policy, path, file.buffer, file.mimetype);
      });
      return { key };
    } catch (e) {
      if (e instanceof ObjectRejected && e.reason !== 'bad_path') throw new GuideRefused(e.reason);
      throw e;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** `null` when the caller's tenant is the platform owner's: it writes the platform's guides. */
  private async ownerOf(actor: GuideActor): Promise<Owner> {
    return actor.tenantId === (await this.platform.id()) ? null : actor.tenantId;
  }

  /** The platform's on the cross-tenant pool (its rows are NULL); a tenant's RLS-bound to it. */
  private run<T>(owner: Owner, fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (owner === null) return this.all.$transaction(fn);
    return runWithTenant({ id: owner }, () => tenantTransaction(this.prisma, fn));
  }

  /** `fn` on an own guide — another owner's is `guide_unknown` — then, when `visible`, the owner's generation bumped. */
  private async write(actor: GuideActor, id: string, visible: boolean, fn: (tx: Tx) => Promise<GuideRow | null>): Promise<GuideDetail> {
    const owner = await this.ownerOf(actor);
    const row = await this.run(owner, async (tx) => {
      if (!(await tx.guide.findFirst({ where: { id, tenantId: owner }, select: { id: true } }))) throw new GuideRefused('guide_unknown', id);
      return fn(tx);
    });
    if (visible) await this.bump(owner);
    return row ? detailOf(row, owner === null ? 'platform' : 'own', false) : (undefined as unknown as GuideDetail);
  }

  /** A failed bump leaves a cached read up to its TTL stale; the write itself stands. */
  private async bump(owner: Owner): Promise<void> {
    await this.generations.bump(owner).catch((err: Error) => this.logger.warn(`guide generation bump failed for ${owner ?? 'platform'}: ${err.message}`));
  }

  /** Registered slots only, each once; a product one the owner can see. */
  private async checkPlacements(tx: Tx, owner: Owner, placements: GuidePlacementInput[]): Promise<GuidePlacementInput[]> {
    const unique = new Map(placements.map((p) => [`${p.surface}:${p.targetKind}:${p.targetRef}`, p]));
    for (const p of unique.values()) {
      const refusal = guideSlotRefusal(p);
      if (refusal) throw new GuideRefused('guide_slot', `${p.targetKind}:${p.targetRef} ${refusal}`);
      if (p.targetKind === GuideTargetKind.product) {
        // RLS shows a reseller the platform's products and its own; the platform only its own (its tenant id, ADR-0142).
        const seen =
          UUID.test(p.targetRef) &&
          (await tx.product.findFirst({ where: { id: p.targetRef, ...(owner === null ? { tenantId: await platformTenantIdOf(tx) } : {}) }, select: { id: true } }));
        if (!seen) throw new GuideRefused('guide_product_unknown', p.targetRef);
      }
    }
    return [...unique.values()];
  }

  /**
   * Every file a text names is the owner's or the platform's shared `guides/`
   * file, stored, public, and of the kind its block plays (F-414-i).
   */
  private async assertFiles(owner: Owner, texts: GuideText[]): Promise<void> {
    const platformId = await this.platform.id();
    const ownStorage = owner ?? platformId;
    const roles = new Map<string, GuideFileRole>();
    for (const text of texts) {
      let named: Map<string, GuideFileRole>;
      try {
        named = guideFileRoles(text.blocks);
      } catch (e) {
        throw new GuideRefused('guide_file', (e as Error).message);
      }
      for (const [key, role] of named) {
        if (roles.get(key) && roles.get(key) !== role) throw new GuideRefused('guide_file', `${key} both a video and an image`);
        roles.set(key, role);
      }
    }
    for (const [key, role] of roles) {
      const parsed = parseObjectKey(key);
      const shared = parsed?.tenantId === platformId && PLATFORM_SHARED_PREFIXES.some((p) => parsed.path.startsWith(p));
      if (!parsed || (parsed.tenantId !== ownStorage && !shared)) throw new GuideRefused('guide_file', key);
      const row = await runWithTenant({ id: parsed.tenantId }, () => this.storage.stat(key));
      if (!row || row.private) throw new GuideRefused('guide_file', key);
      const wrong = fileRoleRefusal(role, row.contentType);
      if (wrong) throw new GuideRefused('guide_file', `${key} ${wrong}`);
    }
  }

}

/** One language each, at least one, each a valid block list (the controller's schema already parsed them). */
function assertTexts(texts: GuideText[]): void {
  if (texts.length === 0 || new Set(texts.map((t) => t.lang)).size !== texts.length) {
    throw new GuideRefused('guide_invalid', 'one text per language, at least one');
  }
  for (const t of texts) {
    if (!guideBlocksSchema.safeParse(t.blocks).success) throw new GuideRefused('guide_invalid', `blocks in ${t.lang}`);
  }
}

function textsOf(rows: { lang: Language; title: string; blocks: Prisma.JsonValue }[]): GuideText[] {
  return rows.map((t) => ({ lang: t.lang, title: t.title, blocks: t.blocks as GuideBlock[] })).sort((a, b) => a.lang.localeCompare(b.lang));
}

function summaryOf(r: GuideRow): GuideSummary {
  return {
    id: r.id,
    key: r.key,
    kind: r.kind,
    sortOrder: r.sortOrder,
    state: !r.isActive ? 'archived' : r.translations.length > 0 ? 'published' : 'draft',
    hasDraft: r.drafts.length > 0,
    publishedLangs: r.translations.map((t) => t.lang).sort(),
    placements: r.placements,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    updatedAt: r.updatedAt.toISOString(),
  };
}

function detailOf(r: GuideRow, owner: 'platform' | 'own', readOnly: boolean): GuideDetail {
  return { ...summaryOf(r), owner, readOnly, published: textsOf(r.translations), draft: textsOf(r.drafts) };
}
