import type { Prisma } from '@prisma/client';
import { normalizeHost } from '@txnet-backend/shared-core';

/** Where an imported user's old link lives: the host its source served it on and the path there (F-203-a). */
export type LegacyPath = { host: string; path: string };

const WEB_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * The host and path of a source client's subscription URL, in the one form
 * `sub-service` compares against (F-203-b): the host as `normalizeHost`
 * keeps it — the old host is a `tenant_domain` once it points here, and a
 * port does not survive that — and the path decoded, without its trailing
 * slash, since an app may fetch it either way. Null for anything that is not
 * someone's link: no address, not http(s), the bare root, a broken escape.
 * The source is adversarial input (catalog §16), so nothing here is trusted.
 */
export function legacyPathOf(subscriptionUrl: string | undefined): LegacyPath | null {
  if (!subscriptionUrl) return null;
  let url: URL;
  let path: string;
  try {
    url = new URL(subscriptionUrl);
    path = decodeURIComponent(url.pathname).replace(/\/+$/, '');
  } catch {
    // An unparseable URL or escape is no link to keep; the import goes on without it.
    return null;
  }
  const host = normalizeHost(url.host);
  if (!WEB_SCHEMES.has(url.protocol) || !host || !path) return null;
  return { host, path };
}

/** One Grant's captured link: `taken` when another Grant of the tenant already answers that path. */
export type LegacyLinkRecord = 'recorded' | 'taken' | 'none';

/**
 * Keeps an imported Grant's old link (F-203-a), inside the commit item's
 * transaction. One Grant per path in a tenant: two source clients sharing a
 * path (3x-ui clients of one subId) leave it to the first, and a retried item
 * writes nothing twice (C-29).
 */
export async function recordLegacyLink(
  tx: Prisma.TransactionClient,
  link: { tenantId: string; grantId: string; migrationItemId: string; subscriptionUrl: string | undefined },
): Promise<LegacyLinkRecord> {
  const at = legacyPathOf(link.subscriptionUrl);
  if (!at) return 'none';
  const { count } = await tx.legacySubLink.createMany({
    data: [{ tenantId: link.tenantId, host: at.host, path: at.path, grantId: link.grantId, migrationItemId: link.migrationItemId }],
    skipDuplicates: true,
  });
  return count === 1 ? 'recorded' : 'taken';
}

/** The Grant's old links stop answering: its import rolled back, or its owner reset the link (F-203-a). */
export async function removeLegacyLinks(tx: Prisma.TransactionClient, grantId: string): Promise<void> {
  await tx.legacySubLink.deleteMany({ where: { grantId } });
}
