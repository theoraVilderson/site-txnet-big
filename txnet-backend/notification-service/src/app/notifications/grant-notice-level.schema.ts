import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

const invalid = BackendI18nKeys.errors.validation.failed;

/**
 * How much a user is told about one of their Grants (F-601-o): every notice,
 * or `essential` — only the `cutoff` kind (a stopped service, a purge, an
 * admin's act). The panel spells the same tuple in `notification-api.ts`.
 */
export const GRANT_NOTICE_LEVELS = ['all', 'essential'] as const;
export type GrantNoticeLevel = (typeof GRANT_NOTICE_LEVELS)[number];

/** One Grant's level, replaced whole. Strict, so a key the panel thinks is saved and this side ignores is a 400. */
export const grantNoticeLevelSchema = z.object({ level: z.enum(GRANT_NOTICE_LEVELS, { message: invalid }) }).strict();

export const grantIdSchema = z.string({ message: invalid }).uuid({ message: invalid });
