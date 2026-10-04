import { GuideSurface, GuideTargetKind } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { GUIDE_SLOTS, guideSlotRefusal } from './guide-slots';

/**
 * F-414-h (ADR-0116 point 2): the one registry of where a guide may be placed.
 * A closed kind holds a list of refs; an open kind (a product, an app) holds a
 * ref's shape, its existence being the writer's check.
 */

const slot = (surface: GuideSurface, targetKind: GuideTargetKind, targetRef: string) => ({
  surface,
  targetKind,
  targetRef,
});

describe('guide slots', () => {
  it('has an entry for every target kind, each with at least one surface', () => {
    expect(Object.keys(GUIDE_SLOTS).sort()).toEqual(Object.values(GuideTargetKind).sort());
    for (const entry of Object.values(GUIDE_SLOTS)) expect(entry.surfaces.length).toBeGreaterThan(0);
  });

  it('accepts a registered panel section, bot screen and OS', () => {
    expect(guideSlotRefusal(slot('panel', 'route', 'services'))).toBeNull();
    expect(guideSlotRefusal(slot('bot', 'bot_screen', 'main_menu'))).toBeNull();
    expect(guideSlotRefusal(slot('any', 'os', 'android'))).toBeNull();
  });

  it('refuses a ref a closed kind does not list — a URL is not a section', () => {
    expect(guideSlotRefusal(slot('panel', 'route', '/services'))).toBe('unknown_ref');
    expect(guideSlotRefusal(slot('panel', 'route', 'nowhere'))).toBe('unknown_ref');
    expect(guideSlotRefusal(slot('any', 'os', 'symbian'))).toBe('unknown_ref');
  });

  it('refuses a surface the kind does not show on', () => {
    expect(guideSlotRefusal(slot('bot', 'route', 'services'))).toBe('surface');
    expect(guideSlotRefusal(slot('any', 'route', 'services'))).toBe('surface');
    expect(guideSlotRefusal(slot('panel', 'bot_screen', 'main_menu'))).toBe('surface');
  });

  it('holds an open kind to its shape only', () => {
    expect(guideSlotRefusal(slot('any', 'app', 'v2rayng'))).toBeNull();
    expect(guideSlotRefusal(slot('panel', 'product', '3f2c1a9e-0b7d-4c55-9a1e-2d4f6b8c0e11'))).toBeNull();
    expect(guideSlotRefusal(slot('any', 'app', 'Has Spaces'))).toBe('bad_ref');
    expect(guideSlotRefusal(slot('any', 'product', ''))).toBe('bad_ref');
  });
});
