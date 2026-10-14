import { describe, expect, it } from "vitest";

import type { AudienceGroup } from "@/lib/auth-api";
import { audienceChanged, audienceRows, pickAudience } from "./audience";

// GR-1-x (ADR-0143): one picker for every feature that aims at an audience.
// "Every user" is a fixed choice, never a group; then the groups the server
// says this caller may pick; a group the record already has but the caller may
// not pick stays visible, so a save never drops it silently.
const VIP: AudienceGroup = { id: "g-vip", name: "VIP", givesKeys: false, userCount: 12 };
const SUPPORT: AudienceGroup = { id: "g-support", name: "Support", givesKeys: true, userCount: 3 };

describe("audienceRows", () => {
  it('starts with "every user", then the pickable groups', () => {
    expect(audienceRows([VIP, SUPPORT], [], { everyone: true })).toEqual([
      { kind: "everyone", selected: true },
      { kind: "group", group: VIP, selected: false },
      { kind: "group", group: SUPPORT, selected: false },
    ]);
  });

  it('leaves "every user" out where a group is required (a lottery)', () => {
    expect(audienceRows([VIP], ["g-vip"], { everyone: false })).toEqual([{ kind: "group", group: VIP, selected: true }]);
  });

  it("keeps a group the record has that this caller may not pick, after the rest", () => {
    expect(audienceRows([VIP], ["g-admin", "g-vip"], { everyone: true })).toEqual([
      { kind: "everyone", selected: false },
      { kind: "group", group: VIP, selected: true },
      { kind: "kept", id: "g-admin" },
    ]);
  });
});

describe("pickAudience", () => {
  it('clears every group when "every user" is picked', () => {
    expect(pickAudience(["g-vip", "g-support"], null, { multiple: true, on: true })).toEqual([]);
  });

  it("replaces the one group in a single picker, and adds or removes in a multiple one", () => {
    expect(pickAudience(["g-vip"], "g-support", { multiple: false, on: true })).toEqual(["g-support"]);
    expect(pickAudience(["g-vip"], "g-support", { multiple: true, on: true })).toEqual(["g-vip", "g-support"]);
    expect(pickAudience(["g-vip", "g-support"], "g-vip", { multiple: true, on: false })).toEqual(["g-support"]);
    expect(pickAudience(["g-vip"], "g-vip", { multiple: true, on: true })).toEqual(["g-vip"]);
  });
});

describe("audienceChanged", () => {
  it("compares as sets", () => {
    expect(audienceChanged(["a", "b"], ["b", "a"])).toBe(false);
    expect(audienceChanged(["a"], [])).toBe(true);
  });
});
