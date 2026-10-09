import { z } from 'zod';

/** `?page=` of either access-history list (AC-1-p), as support's activity reads it. */
export const historyQuerySchema = z.object({ page: z.coerce.number().int().min(1).max(10_000).default(1) }).strict();
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
