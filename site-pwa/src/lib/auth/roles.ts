// A tenant's roles, one person's keys and the access history behind them (AC-1-n).
import { request } from "./credential";
import { resellerUsersApiPath } from "./reseller-users";

/** A role as a tenant's page reads it (F-1201-a): a template is read-only; `members` counts this tenant's holders. */
export interface TenantRole {
  id: string;
  name: string;
  isTemplate: boolean;
  isSystemRole: boolean;
  permissions: string[];
  members: number;
}

/** One permission as `GET /auth/permissions` answers it (AC-1-f), texts in the request's language. */
export interface PermissionEntry {
  key: string;
  label: string;
  description: string;
  platformOnly: boolean;
}

/** One area of the registry: the keys' first segment, labelled. */
export interface PermissionArea {
  area: string;
  label: string;
  permissions: PermissionEntry[];
}

/**
 * A starting point for a new group (GR-1-h): a template the create wizard
 * fills its form from, never a group. `every` is every key the creator may
 * give; otherwise `keys`, which the wizard narrows to what the creator holds.
 */
export interface GroupPreset {
  id: string;
  label: string;
  description: string;
  every: boolean;
  keys: string[];
  /** Platform-only keys it adds on the platform's own groups alone (GR-1-s); absent before auth v-next. */
  platformKeys?: string[];
}

/** A key given or taken on one person: which, why, by whom, since when (AC-1-l). */
export type KeyOverride = { key: string; reason: string; by: string; at: string };

/** One person's keys by source, and the answer they add up to (AC-1-l, ADR-0138). */
export type PersonKeys = {
  userId: string;
  keys: string[];
  role: { id: string; name: string; keys: string[] };
  /** Each group that gives them access, with every key it gives (AC-1-n). */
  groups: { id: string; name: string; keys: string[] }[];
  given: KeyOverride[];
  taken: KeyOverride[];
};

/** `…/users/:userId/keys`, or one key under it (AC-1-l). */
export const personKeysPath = (tenantId: string, userId: string, key?: string) =>
  `${resellerUsersApiPath(tenantId)}/${encodeURIComponent(userId)}/keys${key ? `/${encodeURIComponent(key)}` : ""}`;

export const tenantRolesApiPath = (tenantId: string) => `/auth/tenants/${encodeURIComponent(tenantId)}/roles`;

/**
 * A tenant's roles on its own path (F-1201-a, ADR-0134,
 * [auth-api/contract.roles.md](../../../docs/interfaces/auth-api/contract.roles.md)):
 * the path's tenant, admitted by `ResellerAccess` — the owner of a reseller,
 * its seated admins, or platform staff (the platform's own tenant included).
 * `grantable` is what this caller may tick; `*` means every key.
 */
export const tenantRolesApi = {
  async list(tenantId: string) {
    return request<{ roles: TenantRole[]; grantable: string[] }>(tenantRolesApiPath(tenantId), { method: "GET" });
  },
  async create(tenantId: string, body: { name: string; permissions: string[] }) {
    return request<{ role: Omit<TenantRole, "members"> }>(tenantRolesApiPath(tenantId), { method: "POST", body: JSON.stringify(body) });
  },
  /** `permissions` is the whole set, never a diff. */
  async update(tenantId: string, roleId: string, body: { name?: string; permissions?: string[] }) {
    return request<{ role: Omit<TenantRole, "members"> }>(`${tenantRolesApiPath(tenantId)}/${encodeURIComponent(roleId)}`, { method: "PATCH", body: JSON.stringify(body) });
  },
  /** 409 `role.inUse` while anyone holds it. */
  async remove(tenantId: string, roleId: string) {
    return request<{ id: string }>(`${tenantRolesApiPath(tenantId)}/${encodeURIComponent(roleId)}`, { method: "DELETE" });
  },
  /** One person's role: a role of this tenant or a template, held whole by the caller, over someone they have authority over. */
  async assign(tenantId: string, userId: string, roleId: string) {
    return request<{ userId: string; role: { id: string; name: string } }>(`${resellerUsersApiPath(tenantId)}/${encodeURIComponent(userId)}/role`, {
      method: "PUT",
      body: JSON.stringify({ roleId }),
    });
  },
  /** One person's keys by source (AC-1-l); the role door's `read`. */
  async keysOf(tenantId: string, userId: string) {
    return request<PersonKeys>(personKeysPath(tenantId, userId), { method: "GET" });
  },
  /** Give or take one key, with a reason; a give replaces a take of the same key and the reverse. */
  async setKey(tenantId: string, userId: string, key: string, body: { effect: "give" | "take"; reason: string }) {
    return request<PersonKeys>(personKeysPath(tenantId, userId, key), { method: "PUT", body: JSON.stringify(body) });
  },
  /** Lift a key given or taken: the role and groups decide it again. */
  async liftKey(tenantId: string, userId: string, key: string) {
    return request<PersonKeys>(personKeysPath(tenantId, userId, key), { method: "DELETE" });
  },
  /** The registry (AC-1-f): every key the platform knows, by area, labelled in the request's language, and the group presets (GR-1-h). */
  async permissions() {
    return request<{ areas: PermissionArea[]; presets: GroupPreset[] }>("/auth/permissions", { method: "GET" });
  },
};

/** A user, or the platform's staff, named; `name` null when they have none on record. */
export type NamedActor = { id: string; name: string | null };

/**
 * One act that moved someone's access (AC-1-p, audit `contract.md` "Access
 * history"): who, what (`action` on `target`), the target's state before and
 * after, and the reason typed. `before`/`after` are the act's own shape — a
 * role change `{roleId, roleName}`, a key `{key, effect, reason}`, a group or
 * a role `{roleId?, roleName?, keys}`, a seat `{userId, accessExpiresAt}`.
 */
export type AccessAct = {
  id: string;
  at: string;
  action: string;
  actor: NamedActor;
  target: { type: string; id: string; name: string | null };
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
};

/** A row of one person's history: what their answer gained and lost, and the act (null for their own, a seat accepted). */
export type AccessHistoryItem = {
  id: string;
  at: string;
  cause: string;
  given: string[];
  taken: string[];
  actor: NamedActor;
  act: Omit<AccessAct, "id" | "at" | "actor"> | null;
};

export type AccessHistoryPage<T> = { page: number; items: T[]; more: boolean };

export const accessHistoryPath = (tenantId: string, userId: string) =>
  `${resellerUsersApiPath(tenantId)}/${encodeURIComponent(userId)}/access-history`;

export const accessLogPath = (tenantId: string) => `/auth/tenants/${encodeURIComponent(tenantId)}/access-history`;

/**
 * Who gave whom what (AC-1-p). A person's history is read by whoever reads
 * their keys (`role.manage`) or an auditor (`audit.read`); the tenant's log by
 * `audit.read` alone. 50 a page, newest first.
 */
export const accessHistoryApi = {
  async ofPerson(tenantId: string, userId: string, page: number) {
    return request<AccessHistoryPage<AccessHistoryItem>>(`${accessHistoryPath(tenantId, userId)}?page=${page}`, { method: "GET" });
  },
  async ofTenant(tenantId: string, page: number) {
    return request<AccessHistoryPage<AccessAct & { moved: number }>>(`${accessLogPath(tenantId)}?page=${page}`, { method: "GET" });
  },
};
