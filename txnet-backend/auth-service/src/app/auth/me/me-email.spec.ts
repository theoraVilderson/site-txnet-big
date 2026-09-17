import { BadRequestException } from '@nestjs/common';
import { OtpChannel, OtpPurpose } from '@prisma/client';
import { MeEmailService } from './me-email.service';
import type { AuthClaims } from '../token.service';

/**
 * A user's email address (F-035-g, D-39). One rule carries the feature and
 * every case below is placed to turn red when it breaks:
 *
 * **`user.email` only ever holds an address someone proved they read.** The
 * column is written in exactly one place — after `verifyOtp` accepted a code
 * that was mailed to that address — so every later sender (F-035-h) may treat
 * a non-null `email` as verified without re-checking `emailVerifiedAt`.
 *
 * Two corollaries:
 *  - asking for a code reads no other account. "That address is taken" is
 *    answered only after the code, i.e. only to whoever reads that inbox;
 *    before it, a signed-in user could enumerate a tenant's addresses.
 *  - the address is normalised once, before the code is keyed, so the code
 *    asked for as `Sara@Example.com ` verifies as `sara@example.com`.
 */

const CLAIMS = { sub: 'user-1', tenantId: 'tenant-1' } as AuthClaims;
const HANDLES = { deliveryId: 'd-1', channelId: 'c-1', channelToken: 't-1' };

function harness(current: { email: string | null } = { email: null }) {
  const prisma = {
    user: {
      findUnique: vi.fn().mockResolvedValue({ id: 'user-1', ...current }),
      findFirst: vi.fn(),
      update: vi
        .fn()
        .mockImplementation(({ data }) =>
          Promise.resolve({ email: data.email, emailVerifiedAt: data.emailVerifiedAt }),
        ),
    },
  };
  const otp = {
    issueOtp: vi.fn().mockResolvedValue(undefined),
    verifyOtp: vi.fn().mockResolvedValue(true),
  };
  const deliveries = { mintHandles: vi.fn().mockResolvedValue(HANDLES) };
  const service = new MeEmailService(
    prisma as never,
    otp as never,
    deliveries as never,
  );
  return { prisma, otp, deliveries, service };
}

describe('MeEmailService — asking for a code', () => {
  it('queues an email_verify code on the email channel for the normalised address', async () => {
    const { otp, service } = harness();

    const res = await service.requestCode(CLAIMS, '  Sara@Example.COM ', '1.2.3.4', 'en');

    expect(otp.issueOtp).toHaveBeenCalledWith(
      'sara@example.com',
      OtpPurpose.email_verify,
      OtpChannel.email,
      '1.2.3.4',
      'en',
      HANDLES,
    );
    expect(res).toMatchObject({
      ok: true,
      data: { accepted: true, deliveryId: 'd-1', channelToken: 't-1' },
    });
  });

  it('reads no other account, so it cannot say whether an address is taken', async () => {
    const { prisma, service } = harness();

    await service.requestCode(CLAIMS, 'someone@example.com', '1.2.3.4', 'en');

    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('sends nothing for the address the user already holds', async () => {
    const { otp, service } = harness({ email: 'sara@example.com' });

    const res = await service.requestCode(CLAIMS, 'SARA@example.com', '1.2.3.4', 'en');

    expect(otp.issueOtp).not.toHaveBeenCalled();
    expect(res).toMatchObject({ ok: false, msg: 'auth.emailAlreadyVerified' });
  });
});

describe('MeEmailService — confirming the code', () => {
  it('writes the address and its verification time only after the code verified', async () => {
    const { otp, prisma, service } = harness();

    const res = await service.confirm(CLAIMS, ' Sara@Example.com', '123456');

    expect(otp.verifyOtp).toHaveBeenCalledWith(
      'sara@example.com',
      OtpPurpose.email_verify,
      '123456',
    );
    expect(otp.verifyOtp.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.user.update.mock.invocationCallOrder[0],
    );
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-1' },
        data: { email: 'sara@example.com', emailVerifiedAt: expect.any(Date) },
      }),
    );
    expect(res).toMatchObject({ ok: true, data: { email: 'sara@example.com' } });
  });

  it('writes nothing when the code is wrong', async () => {
    const { otp, prisma, service } = harness();
    otp.verifyOtp.mockRejectedValue(new BadRequestException('invalid otp'));

    await expect(
      service.confirm(CLAIMS, 'sara@example.com', '000000'),
    ).rejects.toThrow('invalid otp');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('answers emailTaken — after the code — when another user of the tenant holds the address', async () => {
    const { prisma, service } = harness();
    prisma.user.update.mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002', meta: { target: ['tenantId', 'email'] } }),
    );

    const res = await service.confirm(CLAIMS, 'sara@example.com', '123456');

    expect(res).toMatchObject({ ok: false, msg: 'auth.emailTaken' });
  });
});
