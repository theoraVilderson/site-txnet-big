import { ObjectNotFound, ObjectStorage, prismaStoredObjects, runWithTenant, tenantTransaction, type ObjectDriver } from '@txnet-backend/shared-core';

import type { PrismaService } from '../../prisma/prisma.service';
import { RECEIPT_IMAGE } from './manual-method';
import { transferRowsOf } from './transfer-rows';

/** A receipt as stored: the type it was checked to be on upload, and its bytes. */
export type StoredReceipt = { contentType: string; bytes: Buffer };

/**
 * A transfer's receipt for its reviewer (F-805-b), in the tenant in scope: the
 * key its proof names, read in the **gateway owner's** scope, where the upload
 * wrote it (F-805-a). Null when no proof names a receipt, or the file is gone.
 * For a surface with no Host to spend the signed URL on — the bot.
 */
export async function readReceipt(prisma: PrismaService, driver: ObjectDriver, paymentId: string): Promise<StoredReceipt | null> {
  const rows = await tenantTransaction(prisma, (tx) => transferRowsOf(tx, paymentId));
  const proof = rows?.detail.proof;
  const key = proof && typeof proof === 'object' && !Array.isArray(proof) ? proof[RECEIPT_IMAGE.id] : null;
  if (!rows || typeof key !== 'string') return null;
  return runWithTenant({ id: rows.setting.tenantId }, () =>
    tenantTransaction(prisma, async (tx) => {
      try {
        const stored = await new ObjectStorage(driver, prismaStoredObjects(tx)).get(key);
        return { contentType: stored.contentType, bytes: stored.bytes };
      } catch (e) {
        if (e instanceof ObjectNotFound) return null;
        throw e;
      }
    }),
  );
}
