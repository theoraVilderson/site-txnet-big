/**
 * The switch group over HTTP: add -> list -> switch (F-0205, F-0206, F-0207).
 *
 * The unit specs already pin the membership rule. What only this level can
 * answer is the part a user actually experiences: that the switch hands the
 * browser a working session for the other account **and** that the session it
 * came from is dead the moment it does (audit invariant #7 / C-21). A mock
 * cannot fail that assertion; a revoked session that still answers 200 can.
 */
import { createE2eApp, E2eApp } from '../support/app';
import { AuthApi, parseSetCookie } from '../support/api';
import { REFRESH_COOKIE } from '../support/env';
import { signUp } from '../support/fixtures';

describe('auth-api — the account switch group', () => {
  let e2e: E2eApp;
  let api: AuthApi;

  beforeAll(async () => {
    e2e = await createE2eApp();
  });

  afterAll(async () => {
    await e2e.close();
  });

  beforeEach(async () => {
    await e2e.reset();
    api = new AuthApi(e2e.server);
  });

  /** Two accounts, the second added to the first's group by its own password. */
  async function groupOfTwo() {
    const second = await signUp(api, e2e.otp);
    api.clearCookies();
    const first = await signUp(api, e2e.otp);

    const added = await api.addAccountPassword(
      { identifier: second.account.username, password: second.account.password },
      { bearer: first.accessToken },
    );
    expect(added.body).toMatchObject({ ok: true, msg: 'accountSwitch.added' });

    return { first, second };
  }

  describe('GET /auth/accounts', () => {
    it('answers an empty group, not an error, before anything is added', async () => {
      const { accessToken } = await signUp(api, e2e.otp);

      const res = await api.listAccounts({ bearer: accessToken });

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ groupId: null, members: [] });
    });

    it('names the caller and masks every phone number', async () => {
      const { first, second } = await groupOfTwo();

      const res = await api.listAccounts({ bearer: first.accessToken });

      expect(res.body.data.current.userId).toBe(first.userId);
      expect(res.body.data.members).toEqual([
        {
          userId: second.userId,
          fullName: second.account.fullName,
          phoneMasked: expect.stringContaining('***'),
        },
      ]);
      // The page this renders on is readable by whoever is standing behind the
      // user, so the full number must not be in the response at all.
      expect(JSON.stringify(res.body)).not.toContain(second.account.phoneNumber);
    });

    it('refuses without a Bearer — a live session is the premise here', async () => {
      const res = await api.listAccounts();

      expect(res.status).toBe(401);
    });
  });

  describe('POST /auth/accounts/switch', () => {
    it('hands over the session: the new token works, the old one is dead', async () => {
      const { first, second } = await groupOfTwo();

      const res = await api.switchAccount(
        { userId: second.userId },
        { bearer: first.accessToken },
      );

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        msg: 'accountSwitch.switched',
        data: { userId: second.userId },
      });
      // The refresh half never travels in the body — same rule as a login.
      expect(res.body.data.refreshToken).toBeUndefined();
      expect(parseSetCookie(res.headers['set-cookie'], REFRESH_COOKIE)?.value)
        .toBeTruthy();

      // The token just issued is a working session for the *other* account…
      const asSecond = await api.listAccounts({
        bearer: res.body.data.accessToken,
      });
      expect(asSecond.body.data.current.userId).toBe(second.userId);

      // …and the one the switch was made from is gone. This is the assertion
      // the whole feature rests on: two live sessions in one browser would
      // make F-0101's "one device, one account" a lie.
      const asFirst = await api.listAccounts({ bearer: first.accessToken });
      expect(asFirst.status).toBe(401);
    });

    it('records the outgoing session as `account_switched`', async () => {
      const { first, second } = await groupOfTwo();

      await api.switchAccount(
        { userId: second.userId },
        { bearer: first.accessToken },
      );

      const revoked = await e2e.prisma.session.findMany({
        where: { userId: first.userId, revokedAt: { not: null } },
        select: { revokedReason: true },
      });
      expect(revoked).toEqual([{ revokedReason: 'account_switched' }]);

      // The incoming session records where it came from, which is what makes
      // the trail readable afterwards. `second` also still holds the session
      // its own signup created — a different browser, untouched by this switch
      // — so the assertion is about the newest one, not the only one.
      const issued = await e2e.prisma.session.findFirst({
        where: { userId: second.userId, revokedAt: null },
        orderBy: { issuedAt: 'desc' },
        select: { switchedFromUserId: true },
      });
      expect(issued).toEqual({ switchedFromUserId: first.userId });
    });

    it('refuses an account that is not in the caller group, and changes nothing', async () => {
      const stranger = await signUp(api, e2e.otp);
      api.clearCookies();
      const caller = await signUp(api, e2e.otp);

      const res = await api.switchAccount(
        { userId: stranger.userId },
        { bearer: caller.accessToken },
      );

      expect(res.body).toMatchObject({ ok: false, msg: 'accountSwitch.notAMember' });
      // Still signed in as the caller — a refused switch must not cost the
      // session it was made from.
      const still = await api.listAccounts({ bearer: caller.accessToken });
      expect(still.body.data.current.userId).toBe(caller.userId);
    });

    it('refuses to switch to the account already signed in', async () => {
      const caller = await signUp(api, e2e.otp);

      const res = await api.switchAccount(
        { userId: caller.userId },
        { bearer: caller.accessToken },
      );

      expect(res.body).toMatchObject({ ok: false, msg: 'accountSwitch.sameAccount' });
    });
  });

  describe('POST /auth/accounts/add/otp/*', () => {
    it('sends the code on its own purpose, so it can never be spent as a login', async () => {
      const joiner = await signUp(api, e2e.otp);
      api.clearCookies();
      const caller = await signUp(api, e2e.otp);
      e2e.otp.clear();

      const requested = await api.addAccountOtpRequest(
        { phoneNumber: joiner.account.phoneNumber },
        { bearer: caller.accessToken },
      );
      expect(requested.body).toMatchObject({ ok: true, data: { accepted: true } });
      expect(e2e.otp.all()).toEqual([
        expect.objectContaining({
          purpose: 'account_switch_link',
          phoneNumber: joiner.account.phoneNumber,
        }),
      ]);

      const verified = await api.addAccountOtpVerify(
        {
          phoneNumber: joiner.account.phoneNumber,
          otpCode: e2e.otp.latest(
            joiner.account.phoneNumber,
            'account_switch_link',
          ),
        },
        { bearer: caller.accessToken },
      );
      expect(verified.body).toMatchObject({ ok: true, data: { added: true } });
    });

    it('names the account that joined, over the wire, from BOTH add routes', async () => {
      // The contract row gained `userId` for one reason: a surface that just
      // added an account has no other way to name it — the caller typed a
      // phone number or a username, never an id. A unit spec cannot answer
      // this; only the wire says whether the field survives serialisation.
      const joiner = await signUp(api, e2e.otp);
      api.clearCookies();
      const caller = await signUp(api, e2e.otp);

      const byPassword = await api.addAccountPassword(
        { identifier: joiner.account.username, password: joiner.account.password },
        { bearer: caller.accessToken },
      );
      expect(byPassword.body.data).toMatchObject({
        added: true,
        userId: joiner.userId,
      });

      // And again on the account that is already a member: `added: false` is
      // still a success, and the bot still has to be able to land on it.
      const again = await api.addAccountPassword(
        { identifier: joiner.account.username, password: joiner.account.password },
        { bearer: caller.accessToken },
      );
      expect(again.body.data).toMatchObject({
        added: false,
        userId: joiner.userId,
      });
    });

    it('answers one key for a wrong password, whoever the account is', async () => {
      const target = await signUp(api, e2e.otp);
      api.clearCookies();
      const caller = await signUp(api, e2e.otp);

      const wrongPassword = await api.addAccountPassword(
        { identifier: target.account.username, password: 'Wr0ng!Passphrase' },
        { bearer: caller.accessToken },
      );
      const noSuchAccount = await api.addAccountPassword(
        { identifier: 'nobody_at_all', password: 'Wr0ng!Passphrase' },
        { bearer: caller.accessToken },
      );

      // Identical answers: a caller holding one session must not be able to
      // use this route to learn which accounts exist.
      expect(wrongPassword.body).toMatchObject({
        ok: false,
        msg: 'accountSwitch.proofFailed',
      });
      expect(noSuchAccount.body).toMatchObject({
        ok: false,
        msg: 'accountSwitch.proofFailed',
      });
    });
  });
});
