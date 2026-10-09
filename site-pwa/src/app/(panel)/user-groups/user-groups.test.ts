import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { Me, UserGroupMember } from "@/lib/auth-api";
import { PANEL_USER_GROUPS } from "@/lib/routes";
import { PANEL_MENU, isMenuGroup, menuHrefs, visibleMenu } from "../_lib/panel-menu";
import {
  ACCESS_KEYS_MAX,
  GROUP_NAME_MAX,
  accessBody,
  receivers,
  MEMBER_IDS_MAX,
  REFUSAL_KEYS,
  USER_GROUP_KEYS,
  USER_GROUP_MANAGE,
  canManageGroups,
  canNameResellers,
  createGroupBody,
  memberSearchOf,
  membersBody,
  parseIds,
  updateGroupBody,
  validateGroupForm,
} from "./_lib/user-groups";

/**
 * The admin's user groups (F-114-m), over auth-service's `/auth/user-groups`
 * (F-114-j). What breaks with nothing red anywhere:
 *  - **a refusal with no sentence** — every `UserGroupRejection` has a line,
 *    read out of the service's own union;
 *  - **a reseller sending what only the platform owner may** — `allTenants`
 *    or reseller ids answer `platform_only`, so the page never builds them for
 *    a reseller in the first place;
 *  - **a body the `.strict()` schema refuses** — a name over 80, an id that is
 *    not a uuid, more than 500 ids in one call, an edit that restates nothing.
 */
const REPO = join(__dirname, "../../../../..");
const LOCALES = join(REPO, "locales/frontend/langs");
const read = (path: string) => readFileSync(join(REPO, "txnet-backend", path), "utf8");
const SERVICE = "auth-service/src/app/governance/user-groups";

const OWNER: Me = {
  userId: "u1",
  fullName: "Theora",
  role: { id: "r1", name: "SuperAdmin" },
  permissions: ["*"],
  tenant: { id: "t-owner", type: "platform_owner", isOwner: false },
  email: null,
  isImpersonated: false,
};
const RESELLER: Me = { ...OWNER, role: { id: "r2", name: "Admin" }, permissions: ["user_group.manage"], tenant: { id: "t-res", type: "reseller", isOwner: true } };
const SUPPORT: Me = { ...OWNER, role: { id: "r3", name: "Support" }, permissions: ["user.search"] };
const A = "22222222-2222-4222-8222-222222222222";
const B = "33333333-3333-4333-8333-333333333333";

describe("what auth-service can refuse this page with", () => {
  it("has a sentence for every reason", () => {
    const union = /export type UserGroupRejection =([\s\S]*?);/.exec(read(`${SERVICE}/user-group.ts`));
    if (!union) throw new Error("UserGroupRejection is no longer a literal union — this test is stale");
    const reasons = [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(Object.keys(REFUSAL_KEYS).sort()).toEqual(reasons.sort());
  });

  it("gates on the service's own permission key and bounds", () => {
    expect(read(`${SERVICE}/user-group.controller.ts`)).toContain(`USER_GROUP_MANAGE = '${USER_GROUP_MANAGE}'`);
    const schema = read(`${SERVICE}/user-group.schema.ts`);
    expect(schema).toContain(`.max(${GROUP_NAME_MAX})`);
    expect(schema).toContain(`.max(${MEMBER_IDS_MAX})`);
  });
});

describe("who sees the page", () => {
  const hrefs = (me: Me) => menuHrefs(visibleMenu(PANEL_MENU, me.permissions, me.tenant.type, me.tenant.isOwner));

  it("is anyone holding user_group.manage — the platform owner and a reseller alike", () => {
    expect(canManageGroups(OWNER)).toBe(true);
    expect(canManageGroups(RESELLER)).toBe(true);
    expect(canManageGroups(SUPPORT)).toBe(false);
    expect(canManageGroups(null)).toBe(false);
    expect(hrefs(OWNER)).toContain(PANEL_USER_GROUPS);
    expect(hrefs(RESELLER)).toContain(PANEL_USER_GROUPS);
    expect(hrefs(SUPPORT)).not.toContain(PANEL_USER_GROUPS);
    const links = PANEL_MENU.flatMap((e) => (isMenuGroup(e) ? e.children : [e]));
    expect(links.find((l) => l.href === PANEL_USER_GROUPS)?.requires).toEqual([USER_GROUP_MANAGE]);
  });

  it("offers resellers and every-reseller to the platform owner only", () => {
    expect(canNameResellers(OWNER)).toBe(true);
    expect(canNameResellers(RESELLER)).toBe(false);
    expect(canNameResellers({ ...RESELLER, permissions: ["*"] })).toBe(false);
  });

  it("finds users the way the caller's tenant can", () => {
    expect(memberSearchOf(OWNER)).toBe("platform");
    expect(memberSearchOf({ ...OWNER, permissions: ["user_group.manage"] })).toBe("ids");
    expect(memberSearchOf(RESELLER)).toBe("reseller");
    expect(memberSearchOf({ ...RESELLER, tenant: { ...RESELLER.tenant, isOwner: false } })).toBe("ids");
    expect(memberSearchOf({ ...RESELLER, tenant: { ...RESELLER.tenant, isOwner: false }, permissions: ["user_group.manage", "user.read"] })).toBe("reseller");
  });
});

describe("the group form", () => {
  it("needs a name of 1-80 once trimmed", () => {
    expect(validateGroupForm({ name: "  " , allTenants: false })).toEqual({ name: USER_GROUP_KEYS.errors.nameRequired });
    expect(validateGroupForm({ name: "x".repeat(81), allTenants: false })).toEqual({ name: USER_GROUP_KEYS.errors.nameTooLong });
    expect(validateGroupForm({ name: " VIP ", allTenants: true })).toEqual({});
  });

  it("never sends allTenants for a reseller", () => {
    expect(createGroupBody({ name: " VIP ", allTenants: true }, RESELLER)).toEqual({ name: "VIP" });
    expect(createGroupBody({ name: "VIP", allTenants: true }, OWNER)).toEqual({ name: "VIP", allTenants: true });
    expect(createGroupBody({ name: "VIP", allTenants: false }, OWNER)).toEqual({ name: "VIP", allTenants: false });
  });

  it("sends only what an edit changed, and nothing when nothing did", () => {
    const was = { name: "VIP", allTenants: false };
    expect(updateGroupBody({ name: " VIP ", allTenants: false }, was, OWNER)).toBeNull();
    expect(updateGroupBody({ name: "Gold", allTenants: false }, was, OWNER)).toEqual({ name: "Gold" });
    expect(updateGroupBody({ name: "VIP", allTenants: true }, was, OWNER)).toEqual({ allTenants: true });
    expect(updateGroupBody({ name: "VIP", allTenants: true }, was, RESELLER)).toBeNull();
  });
});

describe("naming members", () => {
  it("reads ids separated by spaces, commas or lines, once each", () => {
    expect(parseIds(` ${A},${B}\n${A} `)).toEqual({ ids: [A, B], bad: [] });
    expect(parseIds("nope, " + A)).toEqual({ ids: [A], bad: ["nope"] });
    expect(parseIds("")).toEqual({ ids: [], bad: [] });
  });

  it("builds a body with at least one id, at most 500 of each, and no reseller for a reseller", () => {
    expect(membersBody([A], [], OWNER)).toEqual({ userIds: [A] });
    expect(membersBody([], [B], OWNER)).toEqual({ tenantIds: [B] });
    expect(membersBody([A], [B], RESELLER)).toEqual({ userIds: [A] });
    expect(membersBody([], [], OWNER)).toBeNull();
    expect(membersBody([], [B], RESELLER)).toBeNull();
    expect(() => membersBody(Array(MEMBER_IDS_MAX + 1).fill(A), [], OWNER)).toThrow();
  });
});

describe("every key this page can reach", () => {
  const flatten = (v: unknown): string[] =>
    typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(flatten) : [];
  const shipped = (lang: string) => {
    const out = new Set<string>();
    const walk = (prefix: string, value: unknown) => {
      if (value && typeof value === "object") for (const [k, c] of Object.entries(value)) walk(prefix ? `${prefix}.${k}` : k, c);
      else if (typeof value === "string") out.add(prefix);
    };
    walk("", JSON.parse(readFileSync(join(LOCALES, lang, "common.json"), "utf8")));
    return out;
  };

  it.each(["en", "fa"])("resolves in %s", (lang) => {
    const keys = shipped(lang);
    expect(flatten(USER_GROUP_KEYS).filter((k) => !keys.has(k))).toEqual([]);
  });
});

/**
 * The group's Access sheet (AC-1-o) over `PUT /auth/user-groups/:id/access`
 * (AC-1-m): the body is the **whole** set, so a sheet that sends only the
 * ticked difference strips every key it did not show; and "who receives
 * them" is the server's `receivesAccess`, never every member.
 */
describe("a group's access", () => {
  const none = { roleId: null, roleName: null, keys: [] };

  it("sends the whole set, each key once, and nothing when nothing changed", () => {
    expect(accessBody(none, "r-desk", ["ticket.reply", "coupon.manage", "ticket.reply"])).toEqual({ roleId: "r-desk", keys: ["coupon.manage", "ticket.reply"] });
    expect(accessBody({ roleId: "r-desk", roleName: "Desk", keys: ["b.x", "a.x"] }, "r-desk", ["a.x", "b.x"])).toBeNull();
    expect(accessBody({ roleId: "r-desk", roleName: "Desk", keys: [] }, null, [])).toEqual({ roleId: null, keys: [] });
  });

  it("holds the schema's cap on keys", () => {
    expect(read(`${SERVICE}/user-group.schema.ts`)).toMatch(new RegExp(`setUserGroupAccessSchema[\\s\\S]*?\\.max\\(${ACCESS_KEYS_MAX}\\)`));
    expect(() => accessBody(none, null, Array.from({ length: ACCESS_KEYS_MAX + 1 }, (_, i) => `k.k${i}`))).toThrow();
  });

  it("names as receiving only the members the server says receive it", () => {
    const m = (over: Partial<UserGroupMember>): UserGroupMember => ({ memberType: "user", userId: "u", tenantId: null, label: "x", receivesAccess: false, addedAt: "", ...over });
    const here = m({ userId: "u-here", receivesAccess: true });
    expect(receivers([here, m({ userId: "u-far" }), m({ memberType: "tenant", userId: null, tenantId: "t-1" })])).toEqual([here]);
  });

  it("is served by the controller and the member view carries receivesAccess", () => {
    expect(read(`${SERVICE}/user-group.controller.ts`)).toContain("@Put(':id/access')");
    expect(read(`${SERVICE}/user-group-admin.service.ts`)).toMatch(/receivesAccess: boolean/);
  });
});
