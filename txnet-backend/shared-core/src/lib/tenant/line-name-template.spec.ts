import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  LINE_NAME_PLACEHOLDERS,
  MAX_LINE_NAME_TEMPLATE_LENGTH,
  PLATFORM_LINE_NAME_TEMPLATE,
  evaluateLineNameTemplate,
  lineNameTemplateProblem,
  normalizeLineNameTemplate,
} from './line-name-template';

/**
 * A reseller's line-name template (F-307-j, ADR-0089 rule 4). Evaluation is
 * held to `contracts/network/line-names.json`, which `/sub`'s Go half reads
 * too; what may be stored is this side's alone.
 */
const FIXTURE = join(__dirname, '../../../../../contracts/network/line-names.json');

type TemplateCase = { why: string; template: string | null; brand: string; region: string; expect: string };
type Fixture = { platformTemplate: string; placeholders: string[]; maxTemplateLength: number; templateCases: TemplateCase[] };

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;

describe('line-name template', () => {
  it('declares the platform template, the placeholders and the cap the contract does', () => {
    expect(PLATFORM_LINE_NAME_TEMPLATE).toBe(fixture.platformTemplate);
    expect([...LINE_NAME_PLACEHOLDERS]).toEqual(fixture.placeholders);
    expect(MAX_LINE_NAME_TEMPLATE_LENGTH).toBe(fixture.maxTemplateLength);
  });

  it.each(fixture.templateCases.map((c) => [c.why, c] as const))('evaluates: %s', (_why, c) => {
    expect(evaluateLineNameTemplate(c.template, { brand: c.brand, region: c.region })).toBe(c.expect);
  });

  it('stores a template trimmed, and an empty one as the platform default', () => {
    expect(normalizeLineNameTemplate('  {brand} · {region} ')).toBe('{brand} · {region}');
    expect(normalizeLineNameTemplate('   ')).toBeNull();
    expect(normalizeLineNameTemplate(null)).toBeNull();
  });

  it.each([
    ['{brand} · {region}', null],
    ['VPN', null],
    [null, null],
    ['x'.repeat(40), null],
    ['آ'.repeat(40), null],
    ['x'.repeat(41), 'too_long'],
    ['{brand} {n}', 'unknown_placeholder'],
    ['{Region}', 'unknown_placeholder'],
    ['{brand', 'unknown_placeholder'],
    ['brand}', 'unknown_placeholder'],
    ['a\u0007b', 'control_character'],
    ['a‮b', 'control_character'],
  ] as const)('judges %j as %s', (template, problem) => {
    expect(lineNameTemplateProblem(template)).toBe(problem);
  });
});
