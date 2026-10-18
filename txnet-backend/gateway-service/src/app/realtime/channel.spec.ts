import {
  channelRefusal,
  ConnectionIdentity,
  TENANT_CHANNEL_PERMISSION,
  type ChannelProofs,
} from './channel';
import { PLATFORM_CATALOG_ID } from '@txnet-backend/shared-core';

/**
 * The invariant this gateway turns on: **a connection hears its own channels
 * and no others.**
 *
 * It earns the one spec these items are budgeted (`CODE-LAYOUT.md`) because it
 * is the thing that breaks silently. Every other part of the socket announces
 * its own failure — a bad frame is answered, a dead heartbeat closes the
 * connection, a broken upgrade never opens one. A channel authorized too
 * loosely works perfectly for the person testing it and delivers someone
 * else's events to a stranger, with no error anywhere.
 *
 * ADR-0031 made the connection itself optionally anonymous, which is what
 * moved the whole weight of that invariant onto this file: before it, a socket
 * that existed at all had been through the gate, and "whose is this channel?"
 * was asked of an identity that was already proven. Now a connection may have
 * no identity, and the answer for it comes from a proof it presents per
 * channel instead.
 */

const identity = (over: Partial<ConnectionIdentity> = {}): ConnectionIdentity => ({
  userId: 'user-1',
  tenantId: 'tenant-1',
  roleId: 'role-1',
  sessionId: 'sess-1',
  permissions: [],
  ...over,
});

const CHANNEL_ID = 'a'.repeat(32);
const TOKEN = 'b'.repeat(32);

const CONVERSATION = '3d8c81e4-9f15-4456-ac90-aba4ae55b517';
const SUPPORT_TOKEN = 'c'.repeat(64);

/**
 * A proof store holding exactly one live OTP channel, and one support
 * conversation's proof minted for `user-1` (F-034).
 */
const proofs = (token: string | null = TOKEN): ChannelProofs => ({
  otpChannelToken: (channelId) =>
    Promise.resolve(channelId === CHANNEL_ID ? token : null),
  supportChannelToken: (conversationId, userId) =>
    Promise.resolve(conversationId === CONVERSATION && userId === 'user-1' ? SUPPORT_TOKEN : null),
});

const refuse = (
  who: ConnectionIdentity | null,
  channel: string,
  proof: string | null = null,
  store: ChannelProofs = proofs(),
) => channelRefusal({ identity: who, channel, proof }, store);

describe('channelRefusal', () => {
  describe('user channels', () => {
    it('allows a connection its own user channel', async () => {
      await expect(refuse(identity(), 'user:user-1')).resolves.toBeNull();
    });

    it("refuses another user's channel", async () => {
      await expect(refuse(identity(), 'user:user-2')).resolves.toBe(
        'realtime.channelForbidden',
      );
    });

    // The rule that has to survive every later permission being added: no
    // permission grants another person's socket traffic. Acting as someone
    // else is impersonation, and impersonation leaves an `audit` row — a
    // permission that skipped that would make it invisible.
    it("refuses another user's channel however permitted the caller is", async () => {
      const admin = identity({
        permissions: [TENANT_CHANNEL_PERMISSION, 'user.read', 'admin.all'],
      });
      await expect(refuse(admin, 'user:user-2')).resolves.toBe(
        'realtime.channelForbidden',
      );
    });
  });

  describe('tenant channels', () => {
    it('allows own tenant with the permission', async () => {
      const operator = identity({ permissions: [TENANT_CHANNEL_PERMISSION] });
      await expect(refuse(operator, 'tenant:tenant-1')).resolves.toBeNull();
    });

    it('refuses own tenant without the permission', async () => {
      await expect(refuse(identity(), 'tenant:tenant-1')).resolves.toBe(
        'realtime.channelForbidden',
      );
    });

    // The tenancy boundary (ADR-0023). A permission is granted inside one
    // reseller and says nothing about any other, so the permission alone must
    // never be enough.
    it('refuses another tenant even with the permission', async () => {
      const operator = identity({ permissions: [TENANT_CHANNEL_PERMISSION] });
      await expect(refuse(operator, 'tenant:tenant-2')).resolves.toBe(
        'realtime.channelForbidden',
      );
    });

    // F-101-d: `*` stands for the permission, never for the tenant match.
    it('lets "*" stand for the permission, and still refuses another tenant', async () => {
      const superAdmin = identity({ permissions: ['*'] });
      await expect(refuse(superAdmin, 'tenant:tenant-1')).resolves.toBeNull();
      await expect(refuse(superAdmin, 'tenant:tenant-2')).resolves.toBe(
        'realtime.channelForbidden',
      );
      await expect(refuse(superAdmin, 'user:user-2')).resolves.toBe(
        'realtime.channelForbidden',
      );
    });
  });

  /**
   * RT-1-k: the whole tenant's feed — "something changed", type and ids only —
   * so membership is the claim and no permission is asked. The tenant match is
   * still exact: a reseller's users are a different tenant from the platform's.
   */
  describe('members channels', () => {
    it('allows any member of the tenant, with no permission at all', async () => {
      await expect(refuse(identity(), 'members:tenant-1')).resolves.toBeNull();
    });

    it("refuses another tenant's members channel, however permitted the caller is", async () => {
      const superAdmin = identity({ permissions: ['*'] });
      await expect(refuse(superAdmin, 'members:tenant-2')).resolves.toBe('realtime.channelForbidden');
    });
  });

  /**
   * RT-1-p: what a shop shows of a catalog moved — type and ids only. A
   * tenant's own catalog is its members' (exact match); the platform's is
   * sold by every tenant, so any signed-in connection hears `catalog:platform`.
   */
  describe('catalog channels', () => {
    it("allows a member its own tenant's catalog, and nobody another tenant's", async () => {
      await expect(refuse(identity(), 'catalog:tenant-1')).resolves.toBeNull();
      await expect(refuse(identity({ permissions: ['*'] }), 'catalog:tenant-2')).resolves.toBe('realtime.channelForbidden');
    });

    it("allows any signed-in connection the platform's catalog", async () => {
      await expect(refuse(identity({ tenantId: 'reseller-9' }), `catalog:${PLATFORM_CATALOG_ID}`)).resolves.toBeNull();
    });
  });

  /**
   * The half ADR-0031 added. An anonymous connection is a real connection —
   * it just proved nothing at the upgrade — so every channel whose rule is
   * "compare this against who you are" has to refuse it rather than read a
   * field off nothing.
   */
  describe('an anonymous connection', () => {
    it.each([
      ['a user channel', 'user:user-1'],
      ['a tenant channel', 'tenant:tenant-1'],
      ['a members channel', 'members:tenant-1'],
      ['a catalog channel', 'catalog:tenant-1'],
      ["the platform's catalog channel", `catalog:${PLATFORM_CATALOG_ID}`],
    ])('is refused %s', async (_label, channel) => {
      await expect(refuse(null, channel)).resolves.toBe(
        'realtime.channelForbidden',
      );
    });

    // Not a crash, and not an accidental allow: `user:` with an empty id is
    // still an unknown name, and it must not become "matches the anonymous
    // connection's absent user id".
    it('is refused a user channel with an empty id', async () => {
      await expect(refuse(null, 'user:')).resolves.toBe(
        'realtime.channelUnknown',
      );
    });
  });

  /**
   * The OTP delivery channel (F-067-j). The only family whose authorization
   * comes from a secret the client presents rather than from an identity the
   * gate proved — which is the entire reason a pre-login socket can be useful
   * without being a way to listen to strangers.
   */
  describe('otp channels', () => {
    it('allows a connection holding the token, signed in or not', async () => {
      await expect(refuse(null, `otp:${CHANNEL_ID}`, TOKEN)).resolves.toBeNull();
      await expect(
        refuse(identity(), `otp:${CHANNEL_ID}`, TOKEN),
      ).resolves.toBeNull();
    });

    it('refuses a connection that presents no proof', async () => {
      await expect(refuse(null, `otp:${CHANNEL_ID}`, null)).resolves.toBe(
        'realtime.channelForbidden',
      );
    });

    it('refuses a wrong proof', async () => {
      await expect(refuse(null, `otp:${CHANNEL_ID}`, 'c'.repeat(32))).resolves.toBe(
        'realtime.channelForbidden',
      );
    });

    // A proof of a different length must be refused, not throw. Node's
    // constant-time compare rejects mismatched buffers by raising, and an
    // exception in the authorization path is a client-triggerable crash.
    it('refuses a proof of the wrong length without throwing', async () => {
      await expect(refuse(null, `otp:${CHANNEL_ID}`, 'short')).resolves.toBe(
        'realtime.channelForbidden',
      );
    });

    // An id whose TTL has passed and an id nobody ever minted get the same
    // answer, for the same reason the status route gives both `queued`: any
    // other answer restates the account existence the OTP routes refuse.
    it('refuses an expired or never-minted channel', async () => {
      await expect(
        refuse(null, `otp:${CHANNEL_ID}`, TOKEN, proofs(null)),
      ).resolves.toBe('realtime.channelForbidden');
      await expect(refuse(null, `otp:${'d'.repeat(32)}`, TOKEN)).resolves.toBe(
        'realtime.channelForbidden',
      );
    });

    // The store is never asked about a name that could not be an id. A Redis
    // read per malformed channel name is a client-controlled amplifier, and
    // this is the one family whose authorization touches the network at all.
    it('refuses a malformed id without reading the store', async () => {
      const store: ChannelProofs = {
        otpChannelToken: vi.fn().mockResolvedValue(TOKEN),
        supportChannelToken: vi.fn(),
      };
      await expect(refuse(null, 'otp:not-hex', TOKEN, store)).resolves.toBe(
        'realtime.channelForbidden',
      );
      await expect(
        refuse(null, `otp:${CHANNEL_ID}extra`, TOKEN, store),
      ).resolves.toBe('realtime.channelForbidden');
      expect(store.otpChannelToken).not.toHaveBeenCalled();
    });
  });

  // F-034: support-service minted the proof for one reader of one
  // conversation after checking the reader may see it; the gateway holds no
  // database, so the proof — bound to the reader's own id — is the whole claim.
  describe('support channels', () => {
    const channel = `support:${CONVERSATION}`;

    it('allows the reader the proof was minted for', async () => {
      await expect(refuse(identity(), channel, SUPPORT_TOKEN)).resolves.toBeNull();
    });

    it('refuses the same proof presented by another user', async () => {
      await expect(refuse(identity({ userId: 'user-2' }), channel, SUPPORT_TOKEN)).resolves.toBe(
        'realtime.channelForbidden',
      );
    });

    it('refuses an anonymous connection even holding the proof', async () => {
      await expect(refuse(null, channel, SUPPORT_TOKEN)).resolves.toBe('realtime.channelForbidden');
    });

    it('refuses no proof, a wrong one, and one of the wrong length', async () => {
      await expect(refuse(identity(), channel)).resolves.toBe('realtime.channelForbidden');
      await expect(refuse(identity(), channel, 'd'.repeat(64))).resolves.toBe('realtime.channelForbidden');
      await expect(refuse(identity(), channel, 'c')).resolves.toBe('realtime.channelForbidden');
    });

    it('refuses an expired proof, and a conversation nobody minted one for', async () => {
      await expect(
        refuse(identity(), `support:${'1'.repeat(8)}-1111-4111-8111-111111111111`, SUPPORT_TOKEN),
      ).resolves.toBe('realtime.channelForbidden');
    });

    it('refuses a malformed id without reading the store', async () => {
      const store: ChannelProofs = {
        otpChannelToken: vi.fn(),
        supportChannelToken: vi.fn().mockResolvedValue(SUPPORT_TOKEN),
      };
      await expect(refuse(identity(), 'support:not-a-uuid', SUPPORT_TOKEN, store)).resolves.toBe(
        'realtime.channelForbidden',
      );
      expect(store.supportChannelToken).not.toHaveBeenCalled();
    });
  });

  // A channel name is a string the client chose, so every shape that is not
  // one of the families above has to be refused rather than parsed generously.
  describe('names that are not channels', () => {
    it.each([
      ['no separator', 'user'],
      ['empty id', 'user:'],
      ['empty name', ''],
      ['leading separator', ':user-1'],
      ['unknown family', 'presence:user-1'],
      ['family that only looks familiar', 'users:user-1'],
      ['otp family that only looks familiar', 'otps:' + CHANNEL_ID],
      ['support family that only looks familiar', 'supports:' + CONVERSATION],
    ])('refuses %s', async (_label, channel) => {
      await expect(refuse(identity(), channel)).resolves.toBe(
        'realtime.channelUnknown',
      );
    });

    // The id is everything after the *first* colon, so a name cannot be
    // widened by adding more of them.
    it('does not let extra separators widen the match', async () => {
      await expect(refuse(identity(), 'user:user-1:extra')).resolves.toBe(
        'realtime.channelForbidden',
      );
    });
  });
});
