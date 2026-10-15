import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { SystemsDriftEvent, SystemsPanel } from "@/lib/billing-api";
import {
  DRIFT_RESOLUTIONS,
  acknowledgeBodyOf,
  addressMoveOf,
  driftStoryOf,
  resolutionsOf,
} from "./_lib/drift-resolution";
import { panelEditFormOf, validatePanelEdit } from "./_lib/panel-lifecycle";
import { SYSTEMS_KEYS } from "./_lib/systems";

/**
 * A halting `identity_lost` / `address_moved` on the systems page (F-027-fb,
 * ADR-0130, billing `contract.systems.md` rule 9b). What breaks silently:
 *  - an `identity_lost` acknowledged with no choice — billing answers 400
 *    `resolution_required`, after the admin thought it was done;
 *  - a choice sent on any other type — 400 `resolution_not_for_event`;
 *  - the page's choices drifting from billing's `DRIFT_RESOLUTIONS`;
 *  - the CDN opt-out re-sent untouched, or never sent when it changed.
 */
const REPO = join(__dirname, "../../../../..");
const SCHEMA = readFileSync(
  join(
    REPO,
    "txnet-backend/billing-service/src/app/systems/panel-registration.schema.ts",
  ),
  "utf8",
);
const K = SYSTEMS_KEYS.drift;

function event(over: Partial<SystemsDriftEvent>): SystemsDriftEvent {
  return {
    id: "e1",
    panelId: "p1",
    panelName: "de-1",
    eventType: "mass_reset",
    foreignPanel: null,
    affectedConfigCount: 1,
    observedConfigCount: 1,
    detectedAt: "2026-10-15T00:00:00Z",
    collectionHalted: true,
    acknowledgedAt: null,
    acknowledgedByAdminId: null,
    note: null,
    knownAddresses: null,
    seenAddresses: null,
    ...over,
  };
}

describe("drift resolution (F-027-fb)", () => {
  it("offers billing's choices, in its order", () => {
    const tuple =
      /DRIFT_RESOLUTIONS = \[([^\]]+)\] as const/.exec(SCHEMA)?.[1] ?? "";
    expect([...DRIFT_RESOLUTIONS]).toEqual(
      [...tuple.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
    );
  });

  it("asks a choice only of identity_lost", () => {
    expect(resolutionsOf(event({ eventType: "identity_lost" }))).toEqual(
      DRIFT_RESOLUTIONS,
    );
    expect(resolutionsOf(event({ eventType: "address_moved" }))).toEqual([]);
    expect(resolutionsOf(event({ eventType: "mass_reset" }))).toEqual([]);
  });

  it("refuses an identity_lost acknowledgement with no choice, here", () => {
    expect(
      acknowledgeBodyOf(event({ eventType: "identity_lost" }), undefined, null),
    ).toEqual({ ok: false, error: K.chooseResolution });
    expect(
      acknowledgeBodyOf(
        event({ eventType: "identity_lost" }),
        "reinstalled",
        "rebuilt",
      ),
    ).toEqual({
      ok: true,
      body: { note: "reinstalled", resolution: "rebuilt" },
    });
  });

  it("never sends a choice on another type", () => {
    expect(
      acknowledgeBodyOf(
        event({ eventType: "address_moved" }),
        undefined,
        "rebuilt",
      ),
    ).toEqual({ ok: true, body: {} });
    expect(
      acknowledgeBodyOf(event({ eventType: "mass_reset" }), "restore", null),
    ).toEqual({ ok: true, body: { note: "restore" } });
  });

  it("says what happened for the two identity events, and nothing for the rest", () => {
    expect(driftStoryOf(event({ eventType: "identity_lost" }))).toBe(
      K.story.identity_lost,
    );
    expect(driftStoryOf(event({ eventType: "address_moved" }))).toBe(
      K.story.address_moved,
    );
    expect(driftStoryOf(event({ eventType: "mass_reset" }))).toBeNull();
  });

  it("names the old and the new addresses of a move only", () => {
    const moved = event({
      eventType: "address_moved",
      knownAddresses: ["1.1.1.1"],
      seenAddresses: ["2.2.2.2", "3.3.3.3"],
    });
    expect(addressMoveOf(moved)).toEqual({
      known: ["1.1.1.1"],
      seen: ["2.2.2.2", "3.3.3.3"],
    });
    expect(
      addressMoveOf(
        event({
          eventType: "identity_lost",
          knownAddresses: [],
          seenAddresses: [],
        }),
      ),
    ).toBeNull();
  });
});

describe("the CDN opt-out in the panel edit (F-027-fb, billing rule 5b)", () => {
  const panel = {
    id: "p1",
    name: "de-1",
    region: "eu",
    transport: "pull",
    driverType: "x_ui_sanaei",
    ipAddress: null,
    apiBaseUrl: "https://panel.example.com",
    clientBaseUrl: null,
    addressMayMove: false,
    budget: { maxRequestsPerMinute: 60, blockedSince: null },
  } as SystemsPanel;

  it("starts from the panel and is sent only when it changed", () => {
    const form = panelEditFormOf(panel);
    expect(form.addressMayMove).toBe(false);
    expect(validatePanelEdit({ ...form, addressMayMove: true }, panel)).toEqual(
      { ok: true, body: { addressMayMove: true }, credentials: null },
    );
    expect(validatePanelEdit(form, panel)).toEqual({
      ok: false,
      errors: { form: SYSTEMS_KEYS.edit.unchanged },
    });
  });
});
