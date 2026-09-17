import { TenantBillingModel } from '@prisma/client';
import { z } from 'zod';
import { phoneSchema } from '../../common/validation/phone.schema';
import { strongPasswordSchema } from '../../common/validation/strong-password.schema';

/**
 * The wire shape of creating a reseller (F-018-c).
 *
 * `.strict()`: an unknown key is refused, not dropped — `status` and
 * `tenantType` are the service's to set, never the caller's.
 */

/** One DNS label, lower case: the slug is the platform-issued subdomain `<slug>.$DOMAIN_NAME`. */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Labels the platform's own hosts use or will use (`api.$DOMAIN_NAME`,
 * `panel.$DOMAIN_NAME` — dev-docker Traefik rules). A reseller holding one
 * would own a host the platform serves.
 */
export const RESERVED_SLUGS = ['api', 'panel', 'www', 'admin', 'app', 'mail', 'sub', 'assets', 'static', 'cdn'] as const;

/** D-41: subscription only, no metering. */
export const BILLING_MODELS = [TenantBillingModel.subscription_monthly, TenantBillingModel.subscription_yearly] as const;

export const createResellerSchema = z
  .object({
    slug: z
      .string()
      .regex(DNS_LABEL, { message: 'slug must be a lower-case DNS label' })
      .refine((s) => !(RESERVED_SLUGS as readonly string[]).includes(s), { message: 'slug is reserved' }),
    billingModel: z.enum(BILLING_MODELS),
    owner: z
      .object({
        fullName: z.string().trim().min(1).max(120),
        username: z.string().trim().min(3).max(64),
        phoneNumber: phoneSchema,
        password: strongPasswordSchema,
      })
      .strict(),
  })
  .strict();

export type CreateResellerInput = z.infer<typeof createResellerSchema>;

export const listResellersSchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

export type ListResellersInput = z.infer<typeof listResellersSchema>;
