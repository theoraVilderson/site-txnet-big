import { TenantDomainPath, TenantDomainPurpose } from '@prisma/client';
import { normalizeHost } from '@txnet-backend/shared-core';
import { z } from 'zod';

/**
 * The wire shape of adding a custom domain (F-018-i).
 *
 * `.strict()`: the status, the token and the tenant are the service's to set,
 * never the caller's.
 */

/** A registrable host name: two labels at least, each a DNS label. No port, no IP literal. */
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const addDomainSchema = z
  .object({
    domainValue: z
      .string()
      .transform((raw, ctx) => {
        // A port is a typo, not a host: refused, not stripped as `normalizeHost` would.
        const host = raw.includes(':') ? null : normalizeHost(raw);
        if (!host || !HOST.test(host)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'domainValue must be a host name, e.g. panel.example.com' });
          return z.NEVER;
        }
        return host;
      }),
    // `api` is the platform's gateway host (seeded), never a domain a tenant adds.
    purpose: z
      .enum([TenantDomainPurpose.panel, TenantDomainPurpose.subscription, TenantDomainPurpose.assets, TenantDomainPurpose.legacy_sub])
      .default(TenantDomainPurpose.panel),
    // How it reaches us (NIN-1-e1): our Cloudflare unless the reseller chose its own edge.
    path: z.nativeEnum(TenantDomainPath).default(TenantDomainPath.platform_cdn),
  })
  .strict();

export type AddDomainInput = z.infer<typeof addDomainSchema>;

/** `PUT /api/tenants/:id/domains/:domainId/path` (NIN-1-e1). */
export const setPathSchema = z.object({ path: z.nativeEnum(TenantDomainPath) }).strict();

export type SetPathInput = z.infer<typeof setPathSchema>;
