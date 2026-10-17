import { BackendI18nKeys } from '@txnet-backend/shared-core';
import { z } from 'zod';

const E = BackendI18nKeys.errors.billing;

const id = z.string({ message: E.configActionInvalid }).uuid({ message: E.configActionInvalid });

/** The most users one move job may name; a larger move is by panel. */
export const CONFIG_MOVE_MAX_USERS = 500;

/**
 * What a move job takes (F-311-ad): every live config on one panel, or every
 * live config of the users named, wherever it is — never one already on the
 * target. Exactly one of the two.
 */
const sourceSchema = z.union(
  [
    z.object({ panelId: id }).strict(),
    z.object({ userIds: z.array(id).min(1, { message: E.configActionInvalid }).max(CONFIG_MOVE_MAX_USERS, { message: E.configActionInvalid }) }).strict(),
  ],
  { message: E.configActionInvalid },
);

export type ConfigMoveSource = z.infer<typeof sourceSchema>;

/** `POST …/configs/move-jobs/count`: how many configs a move would take now, so the confirm shows it. */
export const configMoveSelectionSchema = z.object({ source: sourceSchema, toPanelId: id }).strict();

export type ConfigMoveSelection = z.infer<typeof configMoveSelectionSchema>;

/**
 * The body of `POST …/configs/move-jobs`: the selection, the target — one of
 * `move-targets` (F-311-v1) — the admin's reason, and a `requestId` the
 * consumer mints once per confirm.
 */
export const configMoveJobSchema = configMoveSelectionSchema
  .extend({ requestId: id, reason: z.string({ message: E.configActionInvalid }).trim().min(1, { message: E.configActionInvalid }).max(500, { message: E.configActionInvalid }) })
  .strict();

export type ConfigMoveJobBody = z.infer<typeof configMoveJobSchema>;
