import type {
  AcknowledgeDriftBody,
  DriftResolution,
  SystemsDriftEvent,
} from "@/lib/billing-api";
import { SYSTEMS_KEYS } from "./systems";

/**
 * The drift report's rules (billing `contract.systems.md` rules 8–9b): whether
 * an event halts and may be acknowledged, and the two events that ask a person
 * what the server is (F-027-fb, ADR-0130 decisions 2 and 4). Billing decides what an acknowledgement writes
 * (`contract.systems.md` rule 9b); this mirrors it so the choice is asked
 * before the call, never refused after it.
 */
const K = SYSTEMS_KEYS.drift;

/** The collector's own test (`collect.Containment.Halted`, billing rule 8) — the page cannot disagree with the loop. */
export function haltsCollection(event: SystemsDriftEvent): boolean {
  return event.collectionHalted && event.acknowledgedAt === null;
}

/** Acknowledging happens once; who decided is never rewritten (billing rule 9). */
export function canAcknowledge(event: SystemsDriftEvent): boolean {
  return event.acknowledgedAt === null;
}

/** billing `DRIFT_RESOLUTIONS`, in its order. */
export const DRIFT_RESOLUTIONS = [
  "rebuilt",
  "address_fixed",
] as const satisfies readonly DriftResolution[];

/** What each choice means and what the next pass does with it. */
export const RESOLUTION_KEYS: Record<
  DriftResolution,
  { label: string; hint: string }
> = K.resolution;

/** The choices an acknowledgement takes: only `identity_lost` asks one (billing `resolution_required`). */
export function resolutionsOf(
  event: SystemsDriftEvent,
): readonly DriftResolution[] {
  return event.eventType === "identity_lost" ? DRIFT_RESOLUTIONS : [];
}

/** What happened, said plainly, for the events a person must tell apart; null for the rest. */
export function driftStoryOf(event: SystemsDriftEvent): string | null {
  if (event.eventType === "identity_lost") return K.story.identity_lost;
  if (event.eventType === "address_moved") return K.story.address_moved;
  return null;
}

/** An `address_moved`'s addresses — accepted at, and answering now; null on any other type. */
export function addressMoveOf(
  event: SystemsDriftEvent,
): { known: string[]; seen: string[] } | null {
  if (event.eventType !== "address_moved") return null;
  return { known: event.knownAddresses ?? [], seen: event.seenAddresses ?? [] };
}

/**
 * The acknowledge body: an `identity_lost` without a choice is refused here
 * (billing 400 `resolution_required`), and a choice is never sent on another
 * type (400 `resolution_not_for_event`), even one picked before.
 */
export function acknowledgeBodyOf(
  event: SystemsDriftEvent,
  note: string | undefined,
  resolution: DriftResolution | null,
): { ok: true; body: AcknowledgeDriftBody } | { ok: false; error: string } {
  const asks = resolutionsOf(event).length > 0;
  if (asks && resolution === null)
    return { ok: false, error: K.chooseResolution };
  const body: AcknowledgeDriftBody = {};
  if (note !== undefined) body.note = note;
  if (asks && resolution !== null) body.resolution = resolution;
  return { ok: true, body };
}
