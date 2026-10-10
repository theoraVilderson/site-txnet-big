import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { Me, UserGroupMember } from "@/lib/auth-api";
import { PANEL_GROUPS, PANEL_ROLES, PANEL_TEAM, PANEL_USER_GROUPS, myResellerGroupsPath } from "@/lib/routes";
import { RESELLER_MENU } from "../_lib/reseller-menu";
import { endOfDay } from "../my-resellers/_lib/team";
import { PANEL_MENU, isMenuGroup, menuHrefs, visibleMenu } from "../_lib/panel-menu";
import {
  ACCESS_KEYS_MAX,
  GROUP_NAME_MAX,
  accessBody,
  endBody,
  groupKeyAreas,
  groupsApiPath,
  isPlatformGroup,
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
  presetDraft,
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
    expect(hrefs(OWNER)).toContain(PANEL_GROUPS);
    expect(hrefs(RESELLER)).toContain(PANEL_GROUPS);
    expect(hrefs(SUPPORT)).not.toContain(PANEL_GROUPS);
    const links = PANEL_MENU.flatMap((e) => (isMenuGroup(e) ? e.children : [e]));
    expect(links.find((l) => l.href === PANEL_GROUPS)?.requires).toEqual([USER_GROUP_MANAGE]);
  });

  it("is the only people page that gives access: Team and Roles have left both menus (GR-1-f, ADR-0139 (1))", () => {
    const links = PANEL_MENU.flatMap((e) => (isMenuGroup(e) ? e.children : [e])).map((l) => (typeof l.href === "function" ? l.href("t-owner", false) : l.href));
    expect(links).not.toContain(PANEL_TEAM);
    expect(links).not.toContain(PANEL_ROLES);
    expect(links).not.toContain(PANEL_USER_GROUPS);
    const workspace = RESELLER_MENU.map((l) => l.href("r-1", false));
    expect(workspace).toContain(myResellerGroupsPath("r-1"));
    expect(workspace.filter((h) => /\/(team|roles)$/.test(h))).toEqual([]);
    expect(RESELLER_MENU.find((l) => l.href("r-1", false) === myResellerGroupsPath("r-1"))?.key).toBe(USER_GROUP_MANAGE);
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

  it("ends every membership an add makes on the day picked, at its last moment, or never", () => {
    expect(membersBody([A], [], OWNER, "2026-12-31")).toEqual({ userIds: [A], expiresAt: endOfDay("2026-12-31") });
    expect(membersBody([A], [], OWNER, null)).toEqual({ userIds: [A] });
    expect(endBody("2026-12-31")).toEqual({ expiresAt: endOfDay("2026-12-31") });
    expect(endBody(null)).toEqual({ expiresAt: null });
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

  it("is keys ticked on the group: the whole set, each once, never a role, and nothing when nothing changed", () => {
    expect(accessBody(none, [], ["ticket.reply", "coupon.manage", "ticket.reply"])).toEqual({ roleId: null, keys: ["coupon.manage", "ticket.reply"] });
    expect(accessBody({ roleId: null, roleName: null, keys: ["b.x", "a.x"] }, [], ["a.x", "b.x"])).toBeNull();
  });

  it("folds a role an older group gives into its keys, the first time it is saved", () => {
    const desk = { roleId: "r-desk", roleName: "Desk", keys: ["coupon.manage"] };
    // Untouched: what it gives already is the role's keys and its own.
    expect(accessBody(desk, ["ticket.read"], ["coupon.manage", "ticket.read"])).toBeNull();
    expect(accessBody(desk, ["ticket.read"], ["ticket.read"])).toEqual({ roleId: null, keys: ["ticket.read"] });
  });

  it("holds the schema's cap on keys", () => {
    expect(read(`${SERVICE}/user-group.schema.ts`)).toMatch(new RegExp(`setUserGroupAccessSchema[\\s\\S]*?\\.max\\(${ACCESS_KEYS_MAX}\\)`));
    expect(() => accessBody(none, [], Array.from({ length: ACCESS_KEYS_MAX + 1 }, (_, i) => `k.k${i}`))).toThrow();
  });

  it("offers platform keys only on the platform's own group (GR-1-e)", () => {
    const registry = [
      { area: "platform", label: "Platform", permissions: [{ key: "platform.report.read", label: "Figures", description: "", platformOnly: true }] },
      { area: "coupons", label: "Coupons", permissions: [{ key: "coupon.manage", label: "Coupons", description: "", platformOnly: false }] },
    ];
    expect(isPlatformGroup(OWNER, null)).toBe(true);
    expect(isPlatformGroup(OWNER, "t-owner")).toBe(true);
    expect(isPlatformGroup(OWNER, "t-res")).toBe(false);
    expect(isPlatformGroup(RESELLER, null)).toBe(false);
    expect(groupKeyAreas(registry, true).map((a) => a.area)).toEqual(["platform", "coupons"]);
    expect(groupKeyAreas(registry, false).map((a) => a.area)).toEqual(["coupons"]);
  });

  it("names as receiving only the members the server says receive it", () => {
    const m = (over: Partial<UserGroupMember>): UserGroupMember => ({ memberType: "user", userId: "u", tenantId: null, label: "x", receivesAccess: false, addedAt: "", expiresAt: null, ...over });
    const here = m({ userId: "u-here", receivesAccess: true });
    expect(receivers([here, m({ userId: "u-far" }), m({ memberType: "tenant", userId: null, tenantId: "t-1" })])).toEqual([here]);
  });

  it("is served by the controller and the member view carries receivesAccess", () => {
    expect(read(`${SERVICE}/user-group.controller.ts`)).toContain("@Put(':id/access')");
    expect(read(`${SERVICE}/user-group-admin.service.ts`)).toMatch(/receivesAccess: boolean/);
  });
});

/** One page for every tenant (GR-1-d/-f): the session's own groups, or a reseller's by its path. */
describe("whose groups", () => {
  it("are the session's on the own page and the path's reseller's on its workspace", () => {
    expect(groupsApiPath(null)).toBe("/auth/user-groups");
    expect(groupsApiPath("r 1")).toBe("/auth/tenants/r%201/user-groups");
  });

  it("is reached from every old address: Team, Roles and user groups redirect here", async () => {
    vi.resetModules();
    vi.doMock("next/navigation", () => ({
      redirect: (to: string) => {
        throw new Error(`redirect:${to}`);
      },
    }));
    const to = async (load: () => Promise<{ default: (p: never) => unknown }>, props: unknown = {}) => {
      try {
        await (await load()).default(props as never);
      } catch (e) {
        return String((e as Error).message).replace("redirect:", "");
      }
      return "rendered";
    };
    const params = { params: Promise.resolve({ id: "r-1" }) };
    expect(await to(() => import("../team/page"))).toBe(PANEL_GROUPS);
    expect(await to(() => import("../roles/page"))).toBe(PANEL_GROUPS);
    expect(await to(() => import("../user-groups/page"))).toBe(PANEL_GROUPS);
    expect(await to(() => import("../my-resellers/[id]/team/page"), params)).toBe(myResellerGroupsPath("r-1"));
    expect(await to(() => import("../my-resellers/[id]/roles/page"), params)).toBe(myResellerGroupsPath("r-1"));
    vi.doUnmock("next/navigation");
  });
});

/** ADR-0139 (1): the page says *group*, never *team* or *role*. */
describe("one word", () => {
  const words = (lang: string) => {
    const all = JSON.parse(readFileSync(join(LOCALES, lang, "common.json"), "utf8"));
    const pick = (path: string) => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], all);
    const flat = (v: unknown): string[] => (typeof v === "string" ? [v] : v && typeof v === "object" ? Object.values(v).flatMap(flat) : []);
    return flat(USER_GROUP_KEYS).map(pick).filter((v): v is string => typeof v === "string");
  };

  it("in English", () => {
    expect(words("en").filter((w) => /\b(team|role)s?\b/i.test(w))).toEqual([]);
  });

  it("in Persian", () => {
    expect(words("fa").filter((w) => /تیم|نقش/.test(w))).toEqual([]);
  });
});

/**
 * GR-1-h — the create wizard's starting point. A preset only fills the form;
 * what it may fill is what this creator can give on this group. What breaks
 * with nothing red: a preset key the creator lacks reaching the PUT (refused
 * `key_not_held` after the group exists), or the admin preset carrying a
 * `platform.` key or the base `self.` keys every user already has.
 */
describe("presetDraft", () => {
  const entry = (key: string, platformOnly = false) => ({ key, label: key, description: "", platformOnly });
  const areas = [
    { area: "user", label: "user", permissions: [entry("user.read"), entry("user.write")] },
    { area: "support", label: "support", permissions: [entry("support.agent")] },
    { area: "self", label: "self", permissions: [entry("self.read")] },
    { area: "platform", label: "platform", permissions: [entry("platform.tenant.create", true)] },
  ];
  const support = { id: "support", label: "Support", description: "", every: false, keys: ["user.read", "support.agent", "restriction.assign"] };
  const admin = { id: "admin", label: "Admin", description: "", every: true, keys: [] };

  it("starts from nothing when no preset is picked", () => {
    expect(presetDraft(null, areas, ["*"])).toEqual({ keys: [], dropped: [] });
  });

  it("keeps the preset keys this creator can give, and names the rest", () => {
    expect(presetDraft(support, areas, ["user.read"])).toEqual({ keys: ["user.read"], dropped: ["restriction.assign", "support.agent"] });
  });

  it("drops a key the offered areas do not show, even under *", () => {
    expect(presetDraft(support, areas, ["*"])).toEqual({ keys: ["support.agent", "user.read"], dropped: ["restriction.assign"] });
  });

  it("gives the admin preset every offered key the creator can give, never platform. or self.", () => {
    expect(presetDraft(admin, areas, ["*"])).toEqual({ keys: ["support.agent", "user.read", "user.write"], dropped: [] });
    expect(presetDraft(admin, areas, ["user.read", "user.write"])).toEqual({ keys: ["user.read", "user.write"], dropped: [] });
  });
});
