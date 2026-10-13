import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { personKeysPath, type PermissionArea, type PersonKeys } from "@/lib/auth-api";
import { instantOf } from "../_lib/datetime";
import { KEY_REASON_MAX, KEY_REASON_MIN, KEY_REFUSAL_KEYS, heldKeys, keyWriteBody, pickableKeys, reasonOk, waitingKeys, windowOk } from "./_lib/person-keys";

/**
 * The Permissions section of a user's Profile tab (AC-1-n) over
 * `GET`/`PUT`/`DELETE …/users/:userId/keys` (AC-1-l). What breaks here with
 * nothing red on the server:
 *
 *  - **a key shown that the person does not hold.** A key taken wins over
 *    the role and every group (ADR-0138), so the list is their answer, not
 *    the sum of the sources;
 *  - **a source left out** — a key the role and a group both give names both,
 *    or lifting one looks like it takes the key away;
 *  - **a key offered that the server refuses** — `*`, a platform-only key, or
 *    one outside the caller's `grantable`;
 *  - **a refusal with no sentence**, read out of the service's own union;
 *  - **a key given for a window** (F-030-c) shown without its end, or — while
 *    its start is ahead, so it is not in the answer yet — not shown at all,
 *    leaving nothing to lift.
 */
const REPO = join(__dirname, "../../../../..");
const SERVICE = "txnet-backend/auth-service/src/app/auth/roles";
const read = (path: string) => readFileSync(join(REPO, path), "utf8");

const view = (over: Partial<PersonKeys> = {}): PersonKeys => ({
  userId: "u-agent",
  keys: ["ticket.read", "ticket.reply", "coupon.manage"],
  role: { id: "r-support", name: "Support", keys: ["ticket.read", "user.write"] },
  groups: [{ id: "g-desk", name: "Desk crew", keys: ["ticket.read", "ticket.reply"] }],
  given: [{ key: "coupon.manage", reason: "runs the spring sale", by: "u-lead", at: "2026-10-01T00:00:00Z", startsAt: null, endsAt: null }],
  taken: [{ key: "user.write", reason: "on probation", by: "u-lead", at: "2026-10-01T00:00:00Z", startsAt: null, endsAt: null }],
  ...over,
});

describe("the keys route", () => {
  it("names the reseller, the user and the key, and the controller serves all three verbs there", () => {
    expect(personKeysPath("t-1", "u-1")).toBe("/auth/tenants/t-1/users/u-1/keys");
    expect(personKeysPath("t-1", "u-1", "coupon.manage")).toBe("/auth/tenants/t-1/users/u-1/keys/coupon.manage");
    const controller = read(`${SERVICE}/tenant-roles.controller.ts`);
    for (const verb of ["@Get('users/:userId/keys')", "@Put('users/:userId/keys/:key')", "@Delete('users/:userId/keys/:key')"]) expect(controller).toContain(verb);
  });

  it("bounds a reason as the route does", () => {
    expect(read(`${SERVICE}/role.schema.ts`)).toContain(`reason: z.string().trim().min(${KEY_REASON_MIN}).max(${KEY_REASON_MAX})`);
    expect(reasonOk("  ok ")).toBe(false);
    expect(reasonOk("covers the night desk")).toBe(true);
    expect(reasonOk("x".repeat(KEY_REASON_MAX + 1))).toBe(false);
  });

  it("has a sentence for every key refusal the service names", () => {
    const union = /export type TenantRolesRejection =([\s\S]*?);/.exec(read(`${SERVICE}/tenant-roles.service.ts`));
    if (!union) throw new Error("TenantRolesRejection is no longer a literal union — this test is stale");
    const own = [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).filter((r) => r.startsWith("key_") || r === "no_authority");
    // A window's refusals (F-030-a) are their own union, joined into this one by name.
    const windows = /export type KeyWindowRejection =([^;]*);/.exec(read(`${SERVICE}/user-keys.view.ts`));
    if (!windows || !union[1].includes("KeyWindowRejection")) throw new Error("KeyWindowRejection moved — this test is stale");
    own.push(...[...windows[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]));
    expect(Object.keys(KEY_REFUSAL_KEYS).sort()).toEqual(own.sort());
  });
});

describe("heldKeys", () => {
  it("lists what they hold, each key with every source that gives it", () => {
    expect(heldKeys(view())).toEqual([
      { key: "coupon.manage", sources: [{ kind: "given", reason: "runs the spring sale", endsAt: null }] },
      { key: "ticket.read", sources: [{ kind: "role" }, { kind: "group", name: "Desk crew" }] },
      { key: "ticket.reply", sources: [{ kind: "group", name: "Desk crew" }] },
    ]);
  });

  it("leaves out a key taken, though the role gives it", () => {
    expect(heldKeys(view()).map((k) => k.key)).not.toContain("user.write");
  });

  it("shows a `*` role as one row", () => {
    expect(heldKeys(view({ keys: ["*"], role: { id: "r-super", name: "SuperAdmin", keys: ["*"] } }))).toEqual([{ key: "*", sources: [{ kind: "role" }] }]);
  });
});

describe("pickableKeys", () => {
  const areas: PermissionArea[] = [
    {
      area: "ticket",
      label: "Tickets",
      permissions: [
        { key: "ticket.read", label: "Read", description: "", platformOnly: false },
        { key: "ticket.reply", label: "Reply", description: "", platformOnly: false },
      ],
    },
    { area: "platform", label: "Platform", permissions: [{ key: "platform.tenant.manage", label: "Tenants", description: "", platformOnly: true }] },
  ];

  it("offers only what the caller may grant", () => {
    expect(pickableKeys(areas, ["ticket.read"]).flatMap((a) => a.permissions.map((p) => p.key))).toEqual(["ticket.read"]);
  });

  it("never offers a platform-only key, even to `*`", () => {
    expect(pickableKeys(areas, ["*"]).flatMap((a) => a.permissions.map((p) => p.key))).toEqual(["ticket.read", "ticket.reply"]);
  });
});

describe("a key given for a window (F-030-c)", () => {
  const NOW = new Date("2026-10-13T12:00:00Z").getTime();
  const windowed = (startsAt: string | null, endsAt: string | null) =>
    view({ given: [{ key: "coupon.manage", reason: "runs the spring sale", by: "u-lead", at: "2026-10-01T00:00:00Z", startsAt, endsAt }] });

  it("carries its end on the held key", () => {
    expect(heldKeys(windowed(null, "2026-10-20T00:00:00Z")).find((k) => k.key === "coupon.manage")?.sources).toEqual([
      { kind: "given", reason: "runs the spring sale", endsAt: "2026-10-20T00:00:00Z" },
    ]);
  });

  it("lists a key whose start is ahead apart — it is not in the answer yet, and can still be lifted", () => {
    const later = { ...windowed("2026-10-15T08:00:00Z", "2026-10-20T00:00:00Z"), keys: ["ticket.read", "ticket.reply"] };
    expect(heldKeys(later).map((k) => k.key)).not.toContain("coupon.manage");
    expect(waitingKeys(later)).toEqual([expect.objectContaining({ key: "coupon.manage", startsAt: "2026-10-15T08:00:00Z", endsAt: "2026-10-20T00:00:00Z" })]);
    expect(waitingKeys(view())).toEqual([]);
  });

  it("sends a give's window as instants, and a take never with one", () => {
    const draft = { key: "coupon.manage", reason: " runs the sale ", startsAt: "2026-10-15T08:00", endsAt: "2026-10-20T18:30" };
    expect(keyWriteBody({ ...draft, effect: "give" })).toEqual({
      effect: "give",
      reason: "runs the sale",
      startsAt: instantOf("2026-10-15T08:00"),
      endsAt: instantOf("2026-10-20T18:30"),
    });
    expect(keyWriteBody({ ...draft, effect: "take" })).toEqual({ effect: "take", reason: "runs the sale" });
    expect(keyWriteBody({ ...draft, effect: "give", startsAt: null, endsAt: null })).toEqual({ effect: "give", reason: "runs the sale" });
  });

  it("accepts a window only when its end is ahead of now and of its start", () => {
    const wall = (iso: string) => {
      const d = new Date(iso);
      const two = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
    };
    expect(windowOk({ startsAt: null, endsAt: null }, NOW)).toBe(true);
    expect(windowOk({ startsAt: null, endsAt: wall("2026-10-14T00:00:00Z") }, NOW)).toBe(true);
    expect(windowOk({ startsAt: null, endsAt: wall("2026-10-12T00:00:00Z") }, NOW)).toBe(false);
    expect(windowOk({ startsAt: wall("2026-10-15T00:00:00Z"), endsAt: wall("2026-10-14T00:00:00Z") }, NOW)).toBe(false);
  });
});
