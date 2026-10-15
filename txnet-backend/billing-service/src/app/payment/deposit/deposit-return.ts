import { ConfigService } from '@nestjs/config';
import { DomainVerificationStatus, Prisma, TenantDomainPurpose, TenantDomainType } from '@prisma/client';

import type { EnvConfig } from '../../config/env.validation';
import { panelUrlOf } from '../../request/panel-url';

/**
 * Where a top-up's payer and its bank come back to (F-092-i, ADR-0020): the
 * two hosts `start` records before a bank is called. Read inside start's first
 * transaction; neither trusts a header the client set without checking it.
 */

/**
 * The panel origin the result page is on: the browser's `Origin`, kept only
 * when CORS already trusts it (`FRONTEND_ORIGIN`) or it is one of this
 * tenant's proven panel hosts. The callback can land on a relay or the API
 * host, so a relative redirect would miss the panel; an origin nobody vouches
 * for is dropped rather than becoming an open redirect.
 */
export async function returnOriginOf(
tx: Prisma.TransactionClient,
config: ConfigService<EnvConfig, true>,
tenantId: string,
origin: string | null | undefined,
): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(origin ?? '');
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  const allowed = config
    .get('FRONTEND_ORIGIN', { infer: true })
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  if (allowed.includes(parsed.origin)) return parsed.origin;

  const rows = await tx.tenantDomain.findMany({
    where: {
      tenantId,
      purpose: TenantDomainPurpose.panel,
      OR: [
        { domainType: TenantDomainType.subdomain },
        { verificationStatus: DomainVerificationStatus.verified },
      ],
    },
    select: { domainValue: true, domainType: true },
    orderBy: [{ domainType: 'desc' }, { domainValue: 'asc' }],
  });
  return parsed.protocol === 'https:' && rows.some((r) => r.domainValue === parsed.host) ? parsed.origin : null;
}

/** A link back to a bot is a button on the result page: https only, and short. */
const BOT_LINK_MAX = 200;

/**
 * The bot a top-up started in (F-093-u), as the link the bot sent with `start`
 * — asked of the bot alone, beside the service token (`DepositController`).
 * It becomes a button on the panel's result page, so only an https link of a
 * sane length is kept.
 */
export function returnBotLinkOf(raw: string | null | undefined): string | null {
  if (!raw || raw.length > BOT_LINK_MAX) return null;
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Where the gateway sends the user back to when the gateway names no address
 * of its own (`callbackUrl`, F-092-w — an operator whose terminal is
 * registered on another domain writes it, and it is sent verbatim) — the tenant's own panel host
 * (ADR-0020), never the platform's and never a header the client set.
 *
 * A proven custom domain wins: it is the brand the user chose to pay on, and
 * a bank's redirect back to a different host reads as a failed payment
 * (`panelUrlOf` holds the rule). With no host, the deposit is refused before
 * a payment exists (F-018-aj).
 *
 * `PAYMENT_CALLBACK_ORIGIN` overrides all of it with one origin for every
 * tenant — a development and test affordance, where no tenant owns a host
 * that a bank's sandbox could reach.
 */
export async function callbackUrlOf(tx: Prisma.TransactionClient, config: ConfigService<EnvConfig, true>, tenantId: string): Promise<string | null> {
  const prefix = config.get('GLOBAL_PREFIX', { infer: true });
  const path = `/${prefix}/billing/deposit/callback`;

  const override = config.get('PAYMENT_CALLBACK_ORIGIN', { infer: true });
  if (override) return `${override.replace(/\/+$/, '')}${path}`;

  return panelUrlOf(tx, tenantId, path);
}
