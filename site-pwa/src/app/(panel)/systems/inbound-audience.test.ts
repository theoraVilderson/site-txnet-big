/**
 * Who sells one inbound, each group's share, and taking groups off it
 * (F-027-eu -> billing F-027-ep/eq/es, ADR-0127). What would break silently:
 *
 *  - **a group taken off an inbound with users there** — billing refuses it
 *    (`inbound_has_configs`); the page must say which groups and how many
 *    users before it asks, and offer the release instead of the save;
 *  - **a share sent for a group that does not list the inbound** — billing's
 *    `listing_not_found`; a share is asked only of a listed seller;
 *  - **a release with no reason, or an empty with no choice for a user left
 *    with nothing** — billing's body refuses both;
 *  - **the member sheet hiding a shared inbound** — since ADR-0127 another
 *    group's inbound is offered and named («مشترک با …»), not held;
 *  - the job's live re-read listening to the wrong event.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { InboundSeller, PanelInbound, PanelInbounds } from "@/lib/billing-api";
import { RealtimeEvents } from "@/generated/wire";
import {
  RELEASE_EVENTS,
  audienceFormOf,
  losing,
  runningRelease,
  shareField,
  soldBy,
  validateAudience,
  validateRelease,
} from "./_lib/inbound-audience";
import { inboundChoices, sellsNobody } from "./_lib/member-settings";

const REPO = join(__dirname, "../../../../..");
const [EU, GAMING, ASIA] = ["g-eu", "g-gaming", "g-asia"];

const seller = (groupId: string, over: Partial<InboundSeller> = {}): InboundSeller => ({
  groupId,
  name: { [EU]: "EU", [GAMING]: "Gaming", [ASIA]: "Asia" }[groupId] ?? groupId,
  share: null,
  clients: 0,
  releaseJobId: null,
  ...over,
});

const inbound = (over: Partial<PanelInbound> = {}): PanelInbound => ({
  remoteId: "3",
  tag: "ovpn",
  protocol: "openvpn",
  port: 1194,
  host: "",
  enabled: true,
  goneAt: null,
  seenAt: "2026-10-17T00:00:00Z",
  sold: true,
  maxClients: null,
  clients: 0,
  audience: "every_group",
  listedTo: [],
  sellers: [],
  ...over,
});

/** A router's OpenVPN listed to EU (12 users, share 30) and Gaming (none); Asia holds the panel too. */
const shared = inbound({
  audience: "listed",
  listedTo: [
    { id: EU, name: "EU" },
    { id: GAMING, name: "Gaming" },
  ],
  sellers: [seller(EU, { clients: 12, share: 30 }), seller(GAMING)],
  clients: 12,
});

const view = (inbounds: PanelInbound[]): PanelInbounds => ({
  panelId: "p-1",
  inboundPlacement: null,
  maxClients: null,
  priority: null,
  weight: null,
  inboundsPerBuyer: null,
  effective: {
    inboundPlacement: { value: "all", layer: "platform" },
    maxClients: { value: null, layer: "platform" },
    priority: { value: 100, layer: "platform" },
    weight: { value: 1, layer: "platform" },
    inboundsPerBuyer: { value: 2, layer: "platform" },
  },
  inboundsReadAt: null,
  users: 12,
  members: [
    { id: ASIA, name: "Asia" },
    { id: EU, name: "EU" },
    { id: GAMING, name: "Gaming" },
  ],
  inbounds,
});

describe("soldBy — the row's one line", () => {
  it("names every group, or the groups listed, or nobody", () => {
    expect(soldBy(inbound())).toEqual({ every: true, names: [] });
    expect(soldBy(shared)).toEqual({ every: false, names: ["EU", "Gaming"] });
    expect(soldBy(inbound({ audience: "listed" }))).toEqual({ every: false, names: [] });
  });
});

describe("losing — groups taken off with users there need a release first", () => {
  it("names the sellers the form drops that have users, with their counts", () => {
    const v = view([shared]);
    const form = { ...audienceFormOf(shared), groups: [GAMING, ASIA] };
    expect(losing(form, v, shared).map((s) => [s.groupId, s.clients])).toEqual([[EU, 12]]);
  });

  it("an every-group inbound narrowed to chosen groups loses the rest", () => {
    const every = inbound({ sellers: [seller(EU, { clients: 4 }), seller(GAMING), seller(ASIA, { clients: 1 })] });
    const form = { ...audienceFormOf(every), audience: "listed" as const, groups: [GAMING] };
    expect(losing(form, view([every]), every).map((s) => s.groupId)).toEqual([EU, ASIA]);
  });

  it("widening to every group loses nobody", () => {
    expect(losing({ ...audienceFormOf(shared), audience: "every_group" }, view([shared]), shared)).toEqual([]);
  });
});

describe("validateAudience — only what changed, a share only for a listed seller", () => {
  it("sends the audience when the groups change, nothing else", () => {
    const checked = validateAudience({ ...audienceFormOf(shared), groups: [EU, GAMING, ASIA] }, shared);
    expect(checked).toEqual({ ok: true, audience: { audience: "listed", groups: [ASIA, EU, GAMING].sort() }, shares: [] });
  });

  it("sends every_group alone, with no groups", () => {
    const checked = validateAudience({ ...audienceFormOf(shared), audience: "every_group" }, shared);
    expect(checked).toMatchObject({ ok: true, audience: { audience: "every_group" } });
  });

  it("sends a changed share, empty as null, for a group that lists it now", () => {
    const form = audienceFormOf(shared);
    form.shares[EU] = "";
    form.shares[GAMING] = "10";
    expect(validateAudience(form, shared)).toEqual({ ok: true, audience: null, shares: [{ groupId: EU, maxClients: null }, { groupId: GAMING, maxClients: 10 }] });
  });

  it("never sends a share on an every-group inbound, or for a group it does not list yet", () => {
    const every = inbound({ sellers: [seller(EU)] });
    const form = audienceFormOf(every);
    form.shares[EU] = "5";
    expect(validateAudience(form, every)).toMatchObject({ ok: false, errors: { form: expect.any(String) } });
  });

  it("refuses a share that is not a whole number from 1, and an untouched form", () => {
    const form = audienceFormOf(shared);
    form.shares[EU] = "0";
    expect(validateAudience(form, shared)).toMatchObject({ ok: false, errors: { [shareField(EU)]: expect.any(String) } });
    expect(validateAudience(audienceFormOf(shared), shared)).toMatchObject({ ok: false, errors: { form: expect.any(String) } });
  });
});

describe("validateRelease — billing's body", () => {
  it("a move needs a reason and sends no orphans", () => {
    expect(validateRelease({ mode: "move", orphans: null, reason: "  router swap  " }, [EU], "req-1")).toEqual({
      ok: true,
      body: { requestId: "req-1", groups: [EU], mode: "move", reason: "router swap" },
    });
    expect(validateRelease({ mode: "move", orphans: null, reason: " " }, [EU], "req-1")).toMatchObject({ ok: false, errors: { reason: expect.any(String) } });
  });

  it("an empty needs what happens to a user left with nothing", () => {
    expect(validateRelease({ mode: "empty", orphans: null, reason: "x" }, [EU], "r")).toMatchObject({ ok: false, errors: { orphans: expect.any(String) } });
    expect(validateRelease({ mode: "empty", orphans: "pause", reason: "x" }, [EU], "r")).toMatchObject({ ok: true, body: { mode: "empty", orphans: "pause" } });
  });
});

describe("a release in flight", () => {
  it("is found on a seller and listened for by its progress event, as events.json names it", () => {
    expect(runningRelease(inbound({ sellers: [seller(EU), seller(GAMING, { releaseJobId: "job-9" })] }))).toBe("job-9");
    expect(runningRelease(shared)).toBeNull();
    const events = JSON.parse(readFileSync(join(REPO, "contracts/realtime/events.json"), "utf8"));
    expect(JSON.stringify(events)).toContain(RealtimeEvents.configMoveJobProgress);
    expect(RELEASE_EVENTS).toEqual([RealtimeEvents.configMoveJobProgress]);
  });
});

describe("the member sheet — a shared inbound is offered and named (ADR-0127)", () => {
  it("offers another group's inbound with whom it is shared, and an every-group one as such", () => {
    const every = inbound({ remoteId: "1" });
    const choices = inboundChoices(view([every, shared]), ASIA, "en");
    expect(choices.map((c) => [c.inbound.remoteId, c.sharedWith, c.everyGroup])).toEqual([
      ["1", "", true],
      ["3", "EU and Gaming", false],
    ]);
    expect(inboundChoices(view([shared]), EU, "en")[0].sharedWith).toBe("Gaming");
  });

  it("a member sells its listings plus every every-group inbound", () => {
    const member = { inbounds: [] as string[] } as never;
    expect(sellsNobody(view([inbound()]), member)).toBe(false);
    expect(sellsNobody(view([shared]), member)).toBe(true);
    expect(sellsNobody(view([shared]), { inbounds: ["3"] } as never)).toBe(false);
  });
});
