import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { PermissionArea, PermissionEntry, PersonKeys } from "@/lib/auth-api";
import { ALL_PERMISSIONS, holdsPermission } from "@/lib/permissions";

const K = FrontendI18nKeys.common.personKeys;

/** Where one held key comes from (AC-1-n). A temporary window (F-030) adds its own kind when it ships. */
export type KeySource = { kind: "role" } | { kind: "group"; name: string } | { kind: "given"; reason: string };

export type HeldKey = { key: string; sources: KeySource[] };

/** A `*` holder: neither widened nor narrowed, so nothing is given or taken (`key_on_wildcard`). */
export const holdsEverything = (view: PersonKeys) => holdsPermission(view.keys, ALL_PERMISSIONS);

/**
 * Every key the person holds — their answer, not the sum of the sources,
 * because a key taken wins over every source (ADR-0138) — each with every
 * source that gives it. A `*` role is the whole answer and has one row.
 */
export function heldKeys(view: PersonKeys): HeldKey[] {
  if (holdsEverything(view)) return [{ key: ALL_PERMISSIONS, sources: [{ kind: "role" }] }];
  return [...view.keys].sort().map((key) => {
    const sources: KeySource[] = [];
    if (holdsPermission(view.role.keys, key)) sources.push({ kind: "role" });
    for (const g of view.groups) if (holdsPermission(g.keys, key)) sources.push({ kind: "group", name: g.name });
    const given = view.given.find((o) => o.key === key);
    if (given) sources.push({ kind: "given", reason: given.reason });
    return { key, sources };
  });
}

/**
 * The keys this caller may give or take on the person, by area: what
 * `grantable` holds (`*` = every key, ADR-0134), never `*` itself or a
 * platform-only key — the server answers `key_not_grantable` to both.
 */
export function pickableKeys(areas: readonly PermissionArea[], grantable: readonly string[]): { area: string; label: string; permissions: PermissionEntry[] }[] {
  return areas
    .map((area) => ({
      area: area.area,
      label: area.label,
      permissions: area.permissions.filter((p) => !p.platformOnly && p.key !== ALL_PERMISSIONS && holdsPermission(grantable, p.key)),
    }))
    .filter((area) => area.permissions.length > 0);
}

/** The route's bounds on a reason (`setKeySchema`); the spec reads both from it. */
export const KEY_REASON_MIN = 3;
export const KEY_REASON_MAX = 500;

export function reasonOk(reason: string): boolean {
  const r = reason.trim();
  return r.length >= KEY_REASON_MIN && r.length <= KEY_REASON_MAX;
}

/**
 * The reasons a key write is refused with beyond the door's (`TenantRolesRejection`).
 * The spec reads the service's union, so a new `key_*` reason ships with its sentence.
 */
export type KeyRefusal = keyof typeof K.refusals;

export const KEY_REFUSAL_KEYS: Record<KeyRefusal, string> = K.refusals;

export function keyRefusalKey(e: unknown): string | null {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in KEY_REFUSAL_KEYS ? KEY_REFUSAL_KEYS[reason as KeyRefusal] : null;
}
