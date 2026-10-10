import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GROUP_PRESETS, PERMISSION_REGISTRY } from '@txnet-backend/shared-core';
import { PermissionRegistryService } from './permission-registry.service';

/**
 * The permission registry answered to the panel (AC-1-f, catalog §3.4). What
 * this pins: the list is the generated one — every key the policy file names,
 * nothing added here — grouped by area, each key with its text in the caller's
 * language, and a missing text shown as the key rather than as nothing.
 */
describe('PermissionRegistryService', () => {
  const tree = {
    areas: { support: { label: 'پشتیبانی' }, platform: { label: 'پلتفرم' } },
    presets: { support: { label: 'پشتیبانی', description: 'پاسخ به تیکت‌ها.' } },
    keys: {
      support: { agent: { label: 'پاسخ به پشتیبانی', description: 'خواندن و پاسخ دادن.' } },
      platform: { tenant: { manage: { label: 'اداره‌ی نماینده‌ها', description: 'فقط برای پلتفرم.' } } },
    },
  };
  const locale = { getNamespace: vi.fn((lang: string, ns: string) => (lang === 'fa' && ns === 'permissions' ? tree : undefined)) };
  const service = new PermissionRegistryService(locale as never);

  it('answers every key of the generated registry, once, grouped by area', () => {
    const { areas } = service.list('fa');
    const keys = areas.flatMap((a) => a.permissions.map((p) => p.key));
    expect(keys.sort()).toEqual(PERMISSION_REGISTRY.map((r) => r.permission).sort());
    for (const area of areas) expect(area.permissions.every((p) => p.key.split('.')[0] === area.area)).toBe(true);
  });

  it('labels a key and its area in the caller language, and says which keys only the platform holds', () => {
    const { areas } = service.list('fa');
    const platform = areas.find((a) => a.area === 'platform');
    expect(platform?.label).toBe('پلتفرم');
    expect(platform?.permissions.find((p) => p.key === 'platform.tenant.manage')).toEqual({
      key: 'platform.tenant.manage',
      label: 'اداره‌ی نماینده‌ها',
      description: 'فقط برای پلتفرم.',
      platformOnly: true,
    });
    expect(areas.find((a) => a.area === 'support')?.permissions.find((p) => p.key === 'support.agent')?.platformOnly).toBe(false);
  });

  it('shows the key itself when a text is missing, never an empty label', () => {
    const { areas } = service.list('en');
    const agent = areas.find((a) => a.area === 'support')?.permissions.find((p) => p.key === 'support.agent');
    expect(agent).toMatchObject({ label: 'support.agent', description: '' });
    expect(areas.find((a) => a.area === 'support')?.label).toBe('support');
  });

  it('answers every group preset with its keys and its text, and the id when a text is missing (GR-1-h)', () => {
    const fa = service.list('fa').presets;
    expect(fa.map((p) => p.id)).toEqual(GROUP_PRESETS.map((p) => p.id));
    expect(fa[0]).toEqual({ id: 'support', label: 'پشتیبانی', description: 'پاسخ به تیکت‌ها.', every: false, keys: [...GROUP_PRESETS[0].keys] });
    expect(fa.find((p) => p.id === 'admin')).toMatchObject({ every: true, keys: [] });
    expect(service.list('en').presets[0]).toMatchObject({ label: 'support', description: '' });
  });

  it('has a Persian and an English text for every preset in the locale files', () => {
    for (const lang of ['fa', 'en']) {
      const file = resolve(__dirname, '../../../../../../locales/backend/langs', lang, 'permissions.json');
      const presets = (JSON.parse(readFileSync(file, 'utf8')) as { presets?: Record<string, { label?: string; description?: string }> }).presets ?? {};
      for (const { id } of GROUP_PRESETS) {
        expect(presets[id]?.label, `${lang}: presets.${id}.label`).toBeTruthy();
        expect(presets[id]?.description, `${lang}: presets.${id}.description`).toBeTruthy();
      }
    }
  });
});
