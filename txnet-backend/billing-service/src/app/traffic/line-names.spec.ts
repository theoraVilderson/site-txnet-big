import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { lineNamesOfGrant, MAX_CONFIG_LABEL_LENGTH, nameLine, PLATFORM_LINE_NAME_TEMPLATE } from './line-names';

/**
 * The TypeScript half of how a served line is named (F-307-g, ADR-0089).
 *
 * `/sub` names the same stored lines in Go (`sub-service`), and a copied line
 * must carry the name an imported `/sub` shows. Nothing is imported across
 * that boundary: `contracts/network/line-names.json` is the declared home of
 * the rule, and each side is held to it by a test of its own — the Go half is
 * `sub-service/internal/sub/line_names_test.go`.
 */
const FIXTURE = join(__dirname, '../../../../../contracts/network/line-names.json');

type LineCase = { why: string; line: string; name: string; expect?: string; expectVmess?: Record<string, unknown> };
type GrantCase = {
  why: string;
  template?: string | null;
  brand?: string;
  configs: { region: string; label: string | null; lines: number }[];
  expectNames: (string | null)[][];
};
type Fixture = { platformTemplate: string; maxLabelLength: number; lineCases: LineCase[]; grantCases: GrantCase[] };

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;

describe('contracts/network/line-names.json', () => {
  it('declares the template and the label cap this side holds', () => {
    expect(PLATFORM_LINE_NAME_TEMPLATE).toBe(fixture.platformTemplate);
    expect(MAX_CONFIG_LABEL_LENGTH).toBe(fixture.maxLabelLength);
  });

  it.each(fixture.lineCases.map((c) => [c.why, c] as const))('names a line: %s', (_why, c) => {
    const named = nameLine(c.line, c.name);
    if (c.expectVmess) {
      expect(named.startsWith('vmess://')).toBe(true);
      expect(JSON.parse(Buffer.from(named.slice('vmess://'.length), 'base64').toString('utf8'))).toEqual(c.expectVmess);
    } else {
      expect(named).toBe(c.expect);
    }
  });

  it.each(fixture.grantCases.map((c) => [c.why, c] as const))('names a Grant: %s', (_why, c) => {
    const configs = c.configs.map((k, i) => ({
      region: k.region,
      label: k.label,
      lines: Array.from({ length: k.lines }, (_, j) => `vless://u@h:1#c${i}-${j}`),
    }));
    const naming = c.template === undefined ? undefined : { template: c.template, brand: c.brand ?? '' };
    expect(lineNamesOfGrant(configs, naming)).toEqual(c.expectNames);
  });
});
