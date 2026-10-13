// User groups: the caller's tenant's, or a reseller's (F-114-m, GR-1-f).
import { request } from "./credential";
import type { ResellerUser } from "./reseller-users";

/** A user group as `/auth/user-groups` answers it (F-114-j, `auth-api/contract.user-groups.md`). */
export type UserGroup = {
  id: string;
  name: string;
  kind: "manual";
  /** The platform owner's only: every reseller is a member. */
  allTenants: boolean;
  userCount: number;
  tenantCount: number;
  /** What the group gives its user members (AC-1-m). */
  access: UserGroupAccess;
  createdAt: string;
  updatedAt: string;
};

/** A role and/or extra keys a group gives its own tenant's user members (AC-1-m). */
export type UserGroupAccess = { roleId: string | null; roleName: string | null; keys: string[] };

/** One member. `label` is a user's name or a reseller's slug — never a phone. */
export type UserGroupMember = {
  memberType: "user" | "tenant";
  userId: string | null;
  tenantId: string | null;
  label: string | null;
  /** A user of the group's own tenant: holds whatever the group gives (AC-1-o). */
  receivesAccess: boolean;
  addedAt: string;
  /** When the membership ends, or null for never (GR-1-c); past it the member is removed. */
  expiresAt: string | null;
};

/**
 * Whose groups a call reaches: `null` the session's tenant (`/auth/user-groups`),
 * or a tenant by its path, behind `ResellerAccess` (GR-1-d, ADR-0139 (5)).
 */
export const groupsApiPath = (tenantId: string | null) =>
  tenantId === null ? "/auth/user-groups" : `/auth/tenants/${encodeURIComponent(tenantId)}/user-groups`;

/**
 * A reseller's groups by the path (F-102-g-d): what its workspace's gateway
 * editor picks an audience from. Invariant 21 decides; read only.
 */
export const resellerUserGroupsApi = {
  async list(tenantId: string) { return request<UserGroup[]>(`/auth/tenants/${encodeURIComponent(tenantId)}/user-groups`, { method: "GET" }); },
};

/** The `POST …/members/changes` body (GR-1-i): one save of a group's members. */
export type MemberChangesBody = {
  add: ({ userId: string; expiresAt: string | null } | { tenantId: string; expiresAt: string | null })[];
  remove: ({ userId: string } | { tenantId: string })[];
  ends: ({ userId: string; expiresAt: string | null } | { tenantId: string; expiresAt: string | null })[];
};

/** Every group route, on the session's tenant or on a tenant by its path ({@link groupsApiPath}). */
export function groupsApi(tenantId: string | null) {
  const base = groupsApiPath(tenantId);
  const userGroupPath = (id: string) => `${base}/${encodeURIComponent(id)}`;
  return {
    async list() { return request<UserGroup[]>(base, { method: "GET" }); },
    async create(body: { name: string; allTenants?: boolean }) { return request<UserGroup>(base, { method: "POST", body: JSON.stringify(body) }); },
    async update(id: string, body: { name?: string; allTenants?: boolean }) { return request<UserGroup>(userGroupPath(id), { method: "PATCH", body: JSON.stringify(body) }); },
    async remove(id: string) { return request<{ id: string; deleted: true }>(userGroupPath(id), { method: "DELETE" }); },
    async members(id: string, page: number, pageSize: number) {
      return request<{ items: UserGroupMember[]; total: number; page: number; pageSize: number }>(`${userGroupPath(id)}/members?page=${page}&pageSize=${pageSize}`, { method: "GET" });
    },
    /** `expiresAt`: the end of every membership this call adds; one already in keeps its own. */
    async addMembers(id: string, body: { userIds?: string[]; tenantIds?: string[]; expiresAt?: string | null }) { return request<{ added: number }>(`${userGroupPath(id)}/members`, { method: "POST", body: JSON.stringify(body) }); },
    /** Move or clear one user's end in place (GR-1-d). */
    async setMemberEnd(id: string, userId: string, body: { expiresAt: string | null }) {
      return request<{ userId: string; expiresAt: string | null }>(`${userGroupPath(id)}/members/users/${encodeURIComponent(userId)}`, { method: "PATCH", body: JSON.stringify(body) });
    },
    /** Every member change of one save, all or none (GR-1-i): adds with their own end, removals, end moves. */
    async changeMembers(id: string, body: MemberChangesBody) {
      return request<{ added: number; removed: number; endsMoved: number }>(`${userGroupPath(id)}/members/changes`, { method: "POST", body: JSON.stringify(body) });
    },
    async removeUser(id: string, userId: string) { return request<{ removed: true }>(`${userGroupPath(id)}/members/users/${encodeURIComponent(userId)}`, { method: "DELETE" }); },
    /** The **whole** access — a role or none, and every extra key (AC-1-m). */
    async setAccess(id: string, body: { roleId: string | null; keys: string[] }) { return request<UserGroup>(`${userGroupPath(id)}/access`, { method: "PUT", body: JSON.stringify(body) }); },
    async removeTenant(id: string, tenantId: string) { return request<{ removed: true }>(`${userGroupPath(id)}/members/tenants/${encodeURIComponent(tenantId)}`, { method: "DELETE" }); },
    /** A reseller finds its own users (F-311-a); the door is `ResellerAccess`, not a permission key. */
    async resellerUsers(tenantId: string, q: string) {
      return request<{ items: ResellerUser[]; total: number }>(`/auth/tenants/${encodeURIComponent(tenantId)}/users?q=${encodeURIComponent(q)}&pageSize=10`, { method: "GET" });
    },
  };
}

export type GroupsApi = ReturnType<typeof groupsApi>;

/** The session's own tenant's groups — what the pickers on other pages read. */
export const userGroupsApi = groupsApi(null);
