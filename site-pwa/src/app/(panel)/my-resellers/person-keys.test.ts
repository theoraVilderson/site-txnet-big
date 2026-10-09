import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { personKeysPath, type PermissionArea, type PersonKeys } from "@/lib/auth-api";
import { KEY_REASON_MAX, KEY_REASON_MIN, KEY_REFUSAL_KEYS, heldKeys, pickableKeys, reasonOk } from "./_lib/person-keys";

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
 *  - **a refusal with no sentence**, read out of the service's own union.
 */
const REPO = join(__dirname, "../../../../..");
const SERVICE = "txnet-backend/auth-service/src/app/auth/roles";
const read = (path: string) => readFileSync(join(REPO, path), "utf8");

const view = (over: Partial<PersonKeys> = {}): PersonKeys => ({
  userId: "u-agent",
  keys: ["ticket.read", "ticket.reply", "coupon.manage"],
  role: { id: "r-support", name: "Support", keys: ["ticket.read", "user.write"] },
  groups: [{ id: "g-desk", name: "Desk crew", keys: ["ticket.read", "ticket.reply"] }],
  given: [{ key: "coupon.manage", reason: "runs the spring sale", by: "u-lead", at: "2026-10-01T00:00:00Z" }],
  taken: [{ key: "user.write", reason: "on probation", by: "u-lead", at: "2026-10-01T00:00:00Z" }],
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
    expect(Object.keys(KEY_REFUSAL_KEYS).sort()).toEqual(own.sort());
  });
});

describe("heldKeys", () => {
  it("lists what they hold, each key with every source that gives it", () => {
    expect(heldKeys(view())).toEqual([
      { key: "coupon.manage", sources: [{ kind: "given", reason: "runs the spring sale" }] },
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
