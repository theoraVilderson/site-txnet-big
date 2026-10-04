import { SupportConsentScope } from '@prisma/client';
import { EMERGENCY_REASON_MIN, SUPPORT_CONSENT_MAX_HOURS } from '@txnet-backend/shared-core';
import { z } from 'zod';

/**
 * Bodies of the consent surface (F-117-a). `.strict()` as on every
 * reseller-named surface: the tenant is the path's, so a body naming one is
 * refused. The scope is derived from the Prisma enum (C-09).
 */
const scope = z.nativeEnum(SupportConsentScope);
const hours = z.number().int().min(1).max(SUPPORT_CONSENT_MAX_HOURS);

export const requestConsentSchema = z
  .object({ scope, reason: z.string().trim().min(10).max(500) })
  .strict();

export const grantConsentSchema = z
  .object({
    scope,
    hours: hours.optional(),
    reason: z.string().trim().max(500).optional(),
    requestId: z.string().uuid().optional(),
  })
  .strict();

export const consentPolicySchema = z.object({ defaultHours: hours }).strict();

/** Tier C's entry (F-117-d): a reason is the whole body, and it is required. */
export const emergencyEntrySchema = z.object({ reason: z.string().trim().min(EMERGENCY_REASON_MIN).max(500) }).strict();

export type EmergencyEntryBody = z.infer<typeof emergencyEntrySchema>;

/** `?page=` of the platform's trail (F-117-c); 50 rows a page. */
export const activityQuerySchema = z.object({ page: z.coerce.number().int().min(1).max(10_000).default(1) }).strict();

export type ActivityQuery = z.infer<typeof activityQuerySchema>;
export type RequestConsentBody = z.infer<typeof requestConsentSchema>;
export type GrantConsentBody = z.infer<typeof grantConsentSchema>;
export type ConsentPolicyBody = z.infer<typeof consentPolicySchema>;
