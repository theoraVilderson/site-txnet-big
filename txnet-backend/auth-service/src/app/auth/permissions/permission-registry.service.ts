import { Injectable } from '@nestjs/common';
import { GROUP_PRESETS, PERMISSION_REGISTRY } from '@txnet-backend/shared-core';

import { LocaleService } from '../../locale/locale.service';

/** One permission as the role editor shows it. */
export type PermissionView = { key: string; label: string; description: string; platformOnly: boolean };

/** One area of the editor: the key's first segment, its label, and its keys. */
export type PermissionAreaView = { area: string; label: string; permissions: PermissionView[] };

/** A starting point for a new group (GR-1-h): `every` is every key the creator may give. */
export type GroupPresetView = { id: string; label: string; description: string; every: boolean; keys: string[] };

/** The locale namespace the texts live in: `areas.<area>.label`, `keys.<key>.{label,description}`. */
const NAMESPACE = 'permissions';

type TextNode = { [segment: string]: TextNode | string | undefined };

/**
 * The permission registry answered to the panel (AC-1-f, catalog §3.4).
 *
 * The list is `PERMISSION_REGISTRY`, generated from `permissions.yaml` by
 * `tools/permissions-gen.py` — the one file the gate also enforces — so no key
 * is named here. The texts are the `permissions` namespace of the `backend`
 * locale scope, read as a tree by the key's own segments (as the OTP builders
 * read theirs), so a new key needs a text and no code. `contracts.py` fails
 * when a key has no English or Persian text; a text missing at runtime shows
 * the key, never an empty label.
 */
@Injectable()
export class PermissionRegistryService {
  constructor(private readonly locale: LocaleService) {}

  list(lang: string): { areas: PermissionAreaView[]; presets: GroupPresetView[] } {
    const tree = (this.locale.getNamespace(lang, NAMESPACE) ?? {}) as TextNode;
    const areas = new Map<string, PermissionAreaView>();
    for (const row of PERMISSION_REGISTRY) {
      let area = areas.get(row.area);
      if (!area) {
        area = { area: row.area, label: text(tree, ['areas', row.area, 'label']) ?? row.area, permissions: [] };
        areas.set(row.area, area);
      }
      const path = ['keys', ...row.permission.split('.')];
      area.permissions.push({
        key: row.permission,
        label: text(tree, [...path, 'label']) ?? row.permission,
        description: text(tree, [...path, 'description']) ?? '',
        platformOnly: row.platformOnly,
      });
    }
    // The create-group wizard's starting points (GR-1-h): templates, never groups.
    const presets = GROUP_PRESETS.map((p) => ({
      id: p.id,
      label: text(tree, ['presets', p.id, 'label']) ?? p.id,
      description: text(tree, ['presets', p.id, 'description']) ?? '',
      every: p.every,
      keys: [...p.keys],
      // Platform-only keys the wizard adds on the platform's own groups alone (GR-1-s).
      platformKeys: [...(p.platformKeys ?? [])],
    }));
    return { areas: [...areas.values()], presets };
  }
}

function text(tree: TextNode, path: string[]): string | undefined {
  let node: TextNode | string | undefined = tree;
  for (const segment of path) node = typeof node === 'object' ? node[segment] : undefined;
  return typeof node === 'string' && node.length > 0 ? node : undefined;
}
