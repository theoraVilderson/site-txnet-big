import { PERMISSION_REGISTRY } from '@txnet-backend/shared-core';
import { PermissionRegistryService } from './permission-registry.service';

/**
 * The permission registry answered to the panel (AC-1-f, catalog §3.4). What
 * this pins: the list is the generated one — every key the policy file names,
 * nothing added here — grouped by area, each key with its text in the caller's
 * language, and a missing text shown as the key rather than as nothing.
 */
describe('PermissionRegistryService', () => {
  const tree = {
    areas: { support: { label: 'پشتیبانی' }, tenant: { label: 'نمایندگی‌ها' } },
    keys: {
      support: { agent: { label: 'پاسخ به پشتیبانی', description: 'خواندن و پاسخ دادن.' } },
      tenant: { manage: { label: 'مدیریت نمایندگی‌ها', description: 'فقط برای پلتفرم.' } },
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
    const tenant = areas.find((a) => a.area === 'tenant');
    expect(tenant?.label).toBe('نمایندگی‌ها');
    expect(tenant?.permissions.find((p) => p.key === 'tenant.manage')).toEqual({
      key: 'tenant.manage',
      label: 'مدیریت نمایندگی‌ها',
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
});
