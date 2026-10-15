import { Language, Prisma } from '@prisma/client';

/**
 * The categories a tenant's user may open under (ADR-0112 point 6): the
 * tenant's own active ones, or — while it has none — the platform's defaults.
 */
export async function visibleCategories(tx: Prisma.TransactionClient, tenantId: string) {
  const query = (owner: string | null) =>
    tx.supportCategory.findMany({
      where: { tenantId: owner, isActive: true },
      include: { texts: true },
      orderBy: [{ sortOrder: 'asc' }, { key: 'asc' }],
    });
  const own = await query(tenantId);
  return own.length > 0 ? own : query(null);
}

/** The name in `lang`, else in the reference language, else any. */
export function nameIn(texts: { lang: Language; name: string }[], lang: string): string | undefined {
  return (
    texts.find((t) => t.lang === lang)?.name ??
    texts.find((t) => t.lang === Language.fa)?.name ??
    texts[0]?.name
  );
}
