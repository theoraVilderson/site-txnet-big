import { PanelGroupMemberRole, PanelReviewState, PanelState, Prisma } from '@prisma/client';

/**
 * Which panels group fulfilment may place a buyer on, and which count towards
 * a group's `minHealthyPanels` (network `contract.groups.md`). One home for
 * both, read by fulfilment, its due-scan and catalog's group list.
 */

/** A new client is written only to a panel that answered us cleanly (network `contract.budget.md`). */
const PLACEABLE_PANEL_STATES: readonly PanelState[] = [PanelState.healthy];

/**
 * A panel still serving its users — sub-api's `servingPanelStates` (sub-api
 * contract "What is served"). A config confirmed there counts towards
 * `minHealthyPanels`; `throttled_or_blocked` refuses our admin calls and still
 * serves. A state added later counts only once it is named here and there.
 */
const SERVING_PANEL_STATES: readonly PanelState[] = [PanelState.healthy, PanelState.degraded, PanelState.throttled_or_blocked];

/** Only an accepted panel is collected (network `contract.registration.md`), so only one is placed on. */
export const PLACEABLE_REVIEW_STATES: readonly PanelReviewState[] = [PanelReviewState.accepted, PanelReviewState.accepted_low_trust];

/**
 * A drift event that still halts its panel (network `contract.drift.md`, the
 * panel-wide event): network neither reads the panel nor, under a foreign
 * claim, converges it, so a config placed there is never made. Such a panel
 * takes no buyer and counts towards no `minHealthyPanels` (F-027-fe, ADR-0130
 * decision 5) until an admin acknowledges it.
 */
export const HALTING_DRIFT_EVENT = { collectionHalted: true, acknowledgedAt: null } satisfies Prisma.PanelDriftEventWhereInput;

/** Selected beside a panel's state: its open halting event, at most one — what {@link placeableMember} reads. */
const PANEL_HALT_FIELDS = { driftEvents: { where: HALTING_DRIFT_EVENT, select: { id: true }, take: 1 } } satisfies Prisma.PanelSelect;

/** Everything {@link placeableMember} and {@link servingPanel} read of a panel — selected wherever a member is judged. */
export const PLACEABLE_PANEL_FIELDS = { reviewState: true, panelState: true, ...PANEL_HALT_FIELDS } satisfies Prisma.PanelSelect;

/** {@link HALTING_DRIFT_EVENT} for a raw scan, over a panel aliased `p`. */
export const PANEL_P_NOT_HALTED = Prisma.sql`NOT EXISTS (SELECT 1 FROM "network"."panel_drift_event" e
                    WHERE e."panelId" = p."id" AND e."collectionHalted" AND e."acknowledgedAt" IS NULL)`;

/** A panel as these rules read it: its review, its state and its open halting event (selected by {@link PANEL_HALT_FIELDS}). */
export type PlaceablePanel = { reviewState: PanelReviewState; panelState: PanelState; driftEvents: { id: string }[] };

const isHalted = (panel: Pick<PlaceablePanel, 'driftEvents'>): boolean => panel.driftEvents.length > 0;

/**
 * A member a new config may be placed on now: not `drain`, its panel accepted,
 * healthy and not halted. What catalog's group list counts as healthy
 * (F-026-p), so the figure an admin picks by is the one fulfilment acts on.
 */
export const placeableMember = (m: { role: PanelGroupMemberRole; panel: PlaceablePanel }): boolean =>
  m.role !== PanelGroupMemberRole.drain &&
  PLACEABLE_REVIEW_STATES.includes(m.panel.reviewState) &&
  PLACEABLE_PANEL_STATES.includes(m.panel.panelState) &&
  !isHalted(m.panel);

/** A panel whose confirmed config counts towards `minHealthyPanels`: serving, and not halted — nothing reads a halted one (F-027-fe). */
export const servingPanel = (panel: Pick<PlaceablePanel, 'panelState' | 'driftEvents'>): boolean =>
  SERVING_PANEL_STATES.includes(panel.panelState) && !isHalted(panel);
