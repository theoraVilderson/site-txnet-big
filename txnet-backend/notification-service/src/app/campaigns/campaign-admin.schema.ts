import { CampaignStatus, Language, NotificationChannel, Prisma, UserStatus } from '@prisma/client';
import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

/**
 * Campaign management's wire shapes (F-035-c). Every refusal is the generic
 * `validation.failed` key with the field's path, as in the inbox schema: the
 * panel's form holds these rules too, so a refusal here is its bug.
 */
const invalid = BackendI18nKeys.errors.validation.failed;

/** Base-currency money as text, never a float (C-02): `wallet.cachedBalance` is `Decimal(18,2)`. */
const money = z.string({ message: invalid }).regex(/^\d{1,16}(\.\d{1,2})?$/, { message: invalid });

/** A non-empty set: empty would read as "nobody" to one reader and "anybody" to another. */
const setOf = <T extends z.ZodTypeAny>(item: T) =>
  z
    .array(item, { message: invalid })
    .min(1, { message: invalid })
    .refine((xs) => new Set(xs).size === xs.length, { message: invalid });

/**
 * **The audience filter — a closed shape, never a query language.** This is the
 * answer to the blocking `filterCriteria` question: `notification_campaign`'s
 * column is `Json`, and this schema is the only thing that writes it. The
 * fan-out (F-035-d) translates exactly these keys to its query and nothing
 * else, so the object is `strict` — an unknown key would be stored, ignored by
 * the worker, and silently widen the audience.
 *
 * Every key narrows; an absent key does not. Keys AND together, a list is any
 * of its values. `{}` is every user in the campaign's scope. `statuses` absent
 * means `active` only — the worker's rule, written here so both sides read it.
 *
 * A new key is added here and in the fan-out in the same change, never in one.
 */
export const audienceFilterSchema = z
  .object({
    statuses: setOf(z.nativeEnum(UserStatus, { message: invalid })).optional(),
    languages: setOf(z.nativeEnum(Language, { message: invalid })).optional(),
    /** `user.createdAt`, inclusive from, exclusive to. */
    registeredFrom: z.string({ message: invalid }).datetime({ offset: true, message: invalid }).optional(),
    registeredTo: z.string({ message: invalid }).datetime({ offset: true, message: invalid }).optional(),
    /** `wallet.cachedBalance`, both inclusive. A user with no wallet has a balance of 0. */
    minBalance: money.optional(),
    maxBalance: money.optional(),
  })
  .strict(invalid)
  .refine((f) => !f.registeredFrom || !f.registeredTo || Date.parse(f.registeredFrom) < Date.parse(f.registeredTo), {
    message: invalid,
    path: ['registeredTo'],
  })
  .refine((f) => !f.minBalance || !f.maxBalance || new Prisma.Decimal(f.minBalance).lte(f.maxBalance), {
    message: invalid,
    path: ['maxBalance'],
  });

export type AudienceFilter = z.infer<typeof audienceFilterSchema>;

/** Telegram's limit is 4096; SMS splits long before that. The adapters (F-035-e/f) cut further. */
const messageBody = z.string({ message: invalid }).trim().min(1, { message: invalid }).max(4000, { message: invalid });
const channel = z.nativeEnum(NotificationChannel, { message: invalid });
/** An email subject (F-035-h); null = the translated default. Other channels store it and send none. */
const subject = z.string({ message: invalid }).trim().min(1, { message: invalid }).max(200, { message: invalid }).nullable();
/** The language the admin writes in; null = `DEFAULT_LANGUAGE`. */
const sourceLang = z.nativeEnum(Language, { message: invalid }).nullable();

/**
 * What a draft is, apart from whose it is. Shared with the reseller-named
 * surface (F-313-d), which takes the scope from its path instead of a body:
 * the two doors differ in the scope and in nothing else, and writing the fields
 * twice is how they would come to differ in more.
 */
export const campaignDraftShape = {
  channel,
  messageBody,
  subject: subject.optional(),
  sourceLang: sourceLang.optional(),
  audience: audienceFilterSchema,
};

/** `tenantId`: absent = the caller's tenant; `null` = platform-wide; another id = the platform owner's alone. */
export const createCampaignSchema = z.object({
  ...campaignDraftShape,
  tenantId: z.string({ message: invalid }).uuid({ message: invalid }).nullable().optional(),
});

/** The scope is fixed at creation: moving a draft between tenants is a new draft. */
export const updateCampaignSchema = z
  .object({
    channel: channel.optional(),
    messageBody: messageBody.optional(),
    subject: subject.optional(),
    sourceLang: sourceLang.optional(),
    audience: audienceFilterSchema.optional(),
  })
  .strict(invalid)
  .refine((b) => Object.keys(b).length > 0, { message: invalid });

/** One language of a campaign (F-035-h): an admin's own text, published as written. */
export const campaignTextSchema = z.object({ subject: subject.optional(), body: messageBody }).strict(invalid);
export const campaignTextLangSchema = z.nativeEnum(Language, { message: invalid });

export const listCampaignsSchema = z.object({
  page: z.coerce.number({ message: invalid }).int({ message: invalid }).positive({ message: invalid }).optional(),
  pageSize: z.coerce.number({ message: invalid }).int({ message: invalid }).positive({ message: invalid }).max(100, { message: invalid }).optional(),
  status: z.nativeEnum(CampaignStatus, { message: invalid }).optional(),
  /** The platform owner's alone; a tenant admin's is ignored. `platform` = platform-wide campaigns. */
  tenantId: z.union([z.literal('platform'), z.string().uuid()], { message: invalid }).optional(),
});

export type ListCampaignsQuery = z.infer<typeof listCampaignsSchema>;
