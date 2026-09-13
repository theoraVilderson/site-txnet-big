import { MeService } from './me.service';
import type { AuthClaims } from '../token.service';

/**
 * `GET /auth/me` exists so a surface can render what the caller may do instead
 * of putting a role word in the URL and trusting it (F-097, D-28). That makes
 * one thing load-bearing, and it is the only thing this spec is about:
 *
 * **`permissions` and `role` are copied from the access token, never re-read
 * from the database.** `forward-auth` enforces the token's list, so a `me` that
 * answered from `identity.role_permission` would disagree with the gate for as
 * long as the token lives (900s by default) — and it would disagree in the
 * dangerous direction, offering a button the edge then refuses. A future edit
 * that "helpfully" joins the role's permissions here is exactly what these
 * cases are placed to turn red, so the fake role below deliberately holds a
 * different set from the claims.
 *
 * The tenant *type* is the one thing not in the token and therefore the one
 * read: it is the second door `audit`'s settlement routes check (invariant #9),
 * so a panel that gated an operator surface on the permission alone would show
 * it to a reseller that granted itself the key.
 */

const CLAIMS: AuthClaims = {
  sub: 'user-1',
  tenantId: 'tenant-1',
  roleId: 'role-admin',
  roleName: 'Admin',
  permissions: ['settlement.manage', 'worker.manage'],
  sessionId: 'session-1',
  iat: 0,
  exp: 0,
};

function harness() {
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'user-1',
        fullName: 'Sara',
        status: 'active',
        deletedAt: null,
        tenantId: 'tenant-1',
        tenant: { id: 'tenant-1', tenantType: 'reseller' },
        // Present on purpose, and holding something else entirely: nothing in
        // the answer may come from here.
        role: {
          id: 'role-admin',
          name: 'RenamedSinceTheTokenWasSigned',
          rolePermissions: [
            { permission: { key: 'user.impersonate' } },
            { permission: { key: 'bot.webhook_rotate' } },
          ],
        },
      }),
    },
  };
  return { prisma, service: new MeService(prisma as never) };
}

describe('MeService.describe', () => {
  it('answers the permissions the token carries, not the role rows behind it', async () => {
    const { service } = harness();

    const res = await service.describe(CLAIMS);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.permissions).toEqual([
      'settlement.manage',
      'worker.manage',
    ]);
    expect(res.data.permissions).not.toContain('user.impersonate');
    expect(res.data.role).toEqual({ id: 'role-admin', name: 'Admin' });
  });

  it('hands back a copy, so a caller cannot edit the claims it was given', async () => {
    const { service } = harness();
    const claims: AuthClaims = { ...CLAIMS, permissions: ['worker.manage'] };

    const res = await service.describe(claims);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    res.data.permissions.push('settlement.manage');
    expect(claims.permissions).toEqual(['worker.manage']);
  });

  it('reads the tenant type, which no claim carries', async () => {
    const { service } = harness();

    const res = await service.describe(CLAIMS);

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.tenant).toEqual({ id: 'tenant-1', type: 'reseller' });
  });

  it('says nothing about a user the row no longer allows', async () => {
    for (const row of [
      null,
      { id: 'user-1', fullName: 'Sara', status: 'suspended', deletedAt: null, tenantId: 'tenant-1', tenant: { id: 'tenant-1', tenantType: 'reseller' } },
      { id: 'user-1', fullName: 'Sara', status: 'active', deletedAt: new Date(), tenantId: 'tenant-1', tenant: { id: 'tenant-1', tenantType: 'reseller' } },
    ]) {
      const { prisma, service } = harness();
      prisma.user.findUnique.mockResolvedValue(row);

      const res = await service.describe(CLAIMS);

      expect(res.ok).toBe(false);
    }
  });

  it('reports an impersonated session as one, so a surface can say so', async () => {
    const { service } = harness();

    const plain = await service.describe(CLAIMS);
    const acting = await service.describe({
      ...CLAIMS,
      isImpersonated: true,
      impersonatedBy: 'operator-9',
    });

    expect(plain.ok && plain.data.isImpersonated).toBe(false);
    expect(acting.ok && acting.data.isImpersonated).toBe(true);
    expect(acting.ok && acting.data.impersonatedBy).toBe('operator-9');
  });
});
