import type { PermissionArea, PermissionEntry } from "@/lib/auth-api";
import { holdsPermission } from "@/lib/permissions";

/** Every registry entry by key, for labelling a role's keys (AC-1-f). */
export function permissionIndex(areas: readonly PermissionArea[]): Map<string, PermissionEntry> {
  return new Map(areas.flatMap((a) => a.permissions.map((p) => [p.key, p] as const)));
}

/**
 * The editor's areas: the keys this caller may grant (`grantable`, `*` = all,
 * ADR-0134), plus the keys the role already holds, so nothing it has is
 * hidden. A held key the caller may not grant is shown, and cannot be changed.
 */
export function editorAreas(
  areas: readonly PermissionArea[],
  grantable: readonly string[],
  held: readonly string[],
): { area: string; label: string; permissions: (PermissionEntry & { locked: boolean })[] }[] {
  return areas
    .map((area) => ({
      area: area.area,
      label: area.label,
      permissions: area.permissions
        .filter((p) => holdsPermission(grantable, p.key) || held.includes(p.key))
        .map((p) => ({ ...p, locked: !holdsPermission(grantable, p.key) })),
    }))
    .filter((area) => area.permissions.length > 0);
}

/** Keys a role holds that the registry does not name — shown raw, never dropped. */
export function unknownKeys(held: readonly string[], index: Map<string, PermissionEntry>): string[] {
  return held.filter((key) => !index.has(key));
}
