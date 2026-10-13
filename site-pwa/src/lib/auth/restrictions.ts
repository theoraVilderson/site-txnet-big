// One person's restrictions — a cap or a bar staff set on them (F-030-d, F-030-f).
import { request } from "./credential";
import { resellerUsersApiPath } from "./reseller-users";

/** A restriction's value: a count, or the options the person is barred from. */
export type RestrictionValue = number | string[];

/** One restriction that holds now: what, how much, why, by whom, since when, until when. */
export type UserRestriction = { key: string; value: RestrictionValue; reason: string; by: string; at: string; expiresAt: string | null };

/** A registry key as a form offers it: a count up to `max`, or some of `options`. */
export type RestrictionKeyView = { key: string; kind: "count"; max: number } | { key: string; kind: "set"; options: string[] };

/** `GET …/restrictions`: the person's restrictions that hold now, and every key that may be set. */
export type PersonRestrictions = { userId: string; restrictions: UserRestriction[]; keys: RestrictionKeyView[] };

/** The `PUT …/restrictions/:key` body; `expiresAt` null or absent holds until lifted. */
export type RestrictionWriteBody = { value: RestrictionValue; reason: string; expiresAt?: string | null };

/** `…/users/:userId/restrictions[/:key]` on the path's tenant (auth-api `contract.reseller-users.md`). */
export const personRestrictionsPath = (tenantId: string, userId: string, key?: string) =>
  `${resellerUsersApiPath(tenantId)}/${encodeURIComponent(userId)}/restrictions${key ? `/${encodeURIComponent(key)}` : ""}`;

/** Every call answers the whole view, so the section re-renders from the server's word. Door: `restriction.assign`. */
export const userRestrictionsApi = {
  async of(tenantId: string, userId: string) {
    return request<PersonRestrictions>(personRestrictionsPath(tenantId, userId), { method: "GET" });
  },
  /** Set or change one; the same value, reason and expiry again writes nothing. */
  async set(tenantId: string, userId: string, key: string, body: RestrictionWriteBody) {
    return request<PersonRestrictions>(personRestrictionsPath(tenantId, userId, key), { method: "PUT", body: JSON.stringify(body) });
  },
  async lift(tenantId: string, userId: string, key: string) {
    return request<PersonRestrictions>(personRestrictionsPath(tenantId, userId, key), { method: "DELETE" });
  },
};
