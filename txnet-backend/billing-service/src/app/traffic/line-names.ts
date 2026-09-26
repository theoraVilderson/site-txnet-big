/**
 * How a served config line is named (F-307-g, ADR-0089): the name a VPN app
 * shows for it, set as the line is answered and never written to a panel.
 *
 * `/sub` names the same stored lines in Go, so the rule is declared in
 * `contracts/network/line-names.json` and each side is held to it by its own
 * test (`line-names.spec.ts` here). A change here is a change there.
 */
import { evaluateLineNameTemplate } from '@txnet-backend/shared-core';

export { PLATFORM_LINE_NAME_TEMPLATE } from '@txnet-backend/shared-core';

/** The longest name a buyer may give a config (CHECK `config_user_label_shape`). */
export const MAX_CONFIG_LABEL_LENGTH = 40;

const URI_LINE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;
const VMESS = 'vmess://';

/** One config's part in its Grant's naming: its buyer's label, its panel's region, and the lines it serves. */
export type NamedConfig = { label: string | null; region: string; lines: readonly string[] };

/** The tenant's part (F-307-j): its template (`null` is the platform's) and its brand name. */
export type LineNaming = { template: string | null; brand: string };

const PLATFORM_NAMING: LineNaming = { template: null, brand: '' };

/**
 * The name of every line of a Grant, config by config, in the order given.
 * The caller passes the configs not retired whose lines are their current
 * client's, oldest first: `/sub` numbers the same list before it drops what
 * it does not serve, so a line is named alike in both. `null` keeps the
 * panel's own name.
 */
export function lineNamesOfGrant(configs: readonly NamedConfig[], naming: LineNaming = PLATFORM_NAMING): (string | null)[][] {
  const given = new Set<string>();
  return configs.map((c) => {
    const base = c.label ?? evaluateLineNameTemplate(naming.template, { brand: naming.brand, region: c.region });
    return c.lines.map(() => {
      if (base === '') return null;
      let name = base;
      for (let n = 2; given.has(name); n++) name = `${base} ${n}`;
      given.add(name);
      return name;
    });
  });
}

/** Every config's lines, named by `lineNamesOfGrant`. */
export function nameGrantLines(configs: readonly NamedConfig[], naming?: LineNaming): string[][] {
  return lineNamesOfGrant(configs, naming).map((names, i) =>
    names.map((name, j) => (name === null ? configs[i].lines[j] : nameLine(configs[i].lines[j], name))),
  );
}

/**
 * `line` carrying `name`: `ps` of a `vmess://` base64 JSON line, else the
 * `#fragment` of any `scheme://` line; any other line is answered unchanged.
 */
export function nameLine(line: string, name: string): string {
  if (line.startsWith(VMESS)) {
    const named = nameVmess(line.slice(VMESS.length), name);
    if (named !== null) return VMESS + named;
  }
  if (!URI_LINE.test(line)) return line;
  const hash = line.indexOf('#');
  return `${hash < 0 ? line : line.slice(0, hash)}#${encodeURIComponent(name)}`;
}

/** The base64 JSON with `ps` set, or `null` when it is not a base64 JSON object. */
function nameVmess(payload: string, name: string): string | null {
  if (!/^[A-Za-z0-9+/=_-]+$/.test(payload)) return null;
  try {
    const obj: unknown = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return Buffer.from(JSON.stringify({ ...obj, ps: name }, null, 2), 'utf8').toString('base64');
  } catch {
    return null;
  }
}
