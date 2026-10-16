import { OtpChannel } from '@prisma/client';
import { TenantContext } from '../tenant-context/tenant-context';
import { SecondFactorService } from './second-factor.service';

/**
 * SA-1-d: after a proven password the person chooses where the code goes, as
 * on the phone login. The `otpToken` the password step handed out is the only
 * thing this route trusts; the code is issued where `verifyLoginOtp` will look
 * for it — the owner's own tenant on a reseller's domain (ADR-0059 (4)).
 */
describe('SecondFactorService.send (SA-1-d)', () => {
  const OWNER_SCOPE = { id: 'tenant-platform', slug: 'platform', via: 'owner' };
  const build = (o: { claims?: unknown; user?: unknown; owner?: unknown } = {}) => {
    const tokens = { verify: vi.fn(() => ('claims' in o ? o.claims : { sub: 'u-1', purpose: 'otp_login' })) };
    const prisma = { user: { findUnique: vi.fn(async () => ('user' in o ? o.user : { id: 'u-1', phoneNumber: '+989121234567' })) } };
    const surfaceOwners = { ownerMatching: vi.fn(async () => o.owner ?? null) };
    let issuedIn: unknown;
    const auth = {
      askSecondFactor: vi.fn(async () => {
        issuedIn = TenantContext.currentOrNull();
        return { ok: true, msg: 'auth.otpSent', data: { requiresOtp: true, otpToken: 'tok-2' } };
      }),
    };
    const service = new SecondFactorService(prisma as never, tokens as never, surfaceOwners as never, auth as never);
    return { service, auth, issued: () => issuedIn };
  };
  const send = (h: ReturnType<typeof build>, channel?: OtpChannel) =>
    h.service.send({ otpToken: 'tok', channel }, '1.2.3.4', 'fa');

  it('sends the code by the chosen channel to the account the token names', async () => {
    const h = build();
    expect(await send(h, OtpChannel.telegram)).toMatchObject({ ok: true, msg: 'auth.otpSent' });
    expect(h.auth.askSecondFactor).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u-1' }), '1.2.3.4', 'fa', OtpChannel.telegram,
    );
  });

  it('refuses a token that is not a password step’s, and sends nothing', async () => {
    const h = build({ claims: { sub: 'u-1', purpose: 'password_reset' } });
    expect(await send(h)).toMatchObject({ ok: false, msg: 'auth.invalidOtpToken' });
    expect(h.auth.askSecondFactor).not.toHaveBeenCalled();
  });

  it("issues the owner's code in the owner's tenant, where the verify step looks", async () => {
    const h = build({ claims: { sub: 'u-owner', purpose: 'otp_login' }, user: null, owner: { user: { id: 'u-owner' }, scope: OWNER_SCOPE } });
    await send(h, OtpChannel.sms);
    expect(h.auth.askSecondFactor).toHaveBeenCalledWith(expect.objectContaining({ id: 'u-owner' }), '1.2.3.4', 'fa', OtpChannel.sms);
    expect(h.issued()).toMatchObject({ id: 'tenant-platform' });
  });

  it('refuses a token naming nobody this door admits', async () => {
    const h = build({ claims: { sub: 'u-gone', purpose: 'otp_login' }, user: null });
    expect(await send(h)).toMatchObject({ ok: false, msg: 'auth.invalidOtpToken' });
    expect(h.auth.askSecondFactor).not.toHaveBeenCalled();
  });
});
