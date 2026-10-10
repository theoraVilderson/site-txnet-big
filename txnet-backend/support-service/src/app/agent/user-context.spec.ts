import { runWithTenant } from '@txnet-backend/shared-core';

import { ConversationRefused } from '../conversations/refusal';
import { SupportUserContext } from './user-context';

/**
 * The invariant this item turns on (catalog §11.3): the sidebar shows **the
 * conversation's own user, of the caller's tenant** — billing is asked only
 * after support found the thread in that tenant, with that tenant and user,
 * never an id the caller typed — and a billing that does not answer leaves the
 * sidebar empty, never the conversation broken.
 */
describe('SupportUserContext', () => {
  const caller = { tenantId: 'tenant-1', userId: 'agent-1' };
  const facts = { wallet: null, grants: { items: [], hidden: 0 }, invoices: [], lastConnectionAt: null };

  const build = (opts: { thread?: { userId: string } | null; seam?: () => Promise<unknown> } = {}) => {
    const findFirst = vi.fn(async () => (opts.thread === undefined ? { userId: 'user-9' } : opts.thread));
    const seam = { of: vi.fn(opts.seam ?? (async () => facts)) };
    const bound: unknown[] = [];
    const tx = {
      $executeRaw: vi.fn(async (_s: unknown, tenantId: unknown) => {
        bound.push(tenantId);
      }),
      supportConversation: { findFirst },
      // The person's name, in the same tenant transaction (F-033-r's sidebar).
      user: { findFirst: vi.fn(async () => ({ fullName: 'Ali Rezaei', username: 'ali_r' })) },
    };
    const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    const raw = new SupportUserContext(prisma as never, seam as never);
    // The request's scope, as IdentityMiddleware opens it.
    const context = { forConversation: (c: typeof caller, id: string) => runWithTenant({ id: c.tenantId }, () => raw.forConversation(c, id)) };
    return { context, findFirst, seam, bound };
  };

  it("finds the thread in the caller's tenant, then asks billing for that tenant and the thread's user", async () => {
    const { context, findFirst, seam, bound } = build();
    await expect(context.forConversation(caller, 'conv-1')).resolves.toEqual({
      userId: 'user-9',
      user: { fullName: 'Ali Rezaei', username: 'ali_r' },
      billing: facts,
    });
    expect(bound).toEqual(['tenant-1']);
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'conv-1', tenantId: 'tenant-1' } }));
    expect(seam.of).toHaveBeenCalledWith('tenant-1', 'user-9');
  });

  it("another tenant's thread is not_found, and billing is never asked", async () => {
    const { context, seam } = build({ thread: null });
    await expect(context.forConversation(caller, 'conv-x')).rejects.toEqual(new ConversationRefused('not_found'));
    expect(seam.of).not.toHaveBeenCalled();
  });

  it('a billing that fails answers billing: null, not an error', async () => {
    const { context } = build({
      seam: async () => {
        throw new Error('billing answered 502');
      },
    });
    await expect(context.forConversation(caller, 'conv-1')).resolves.toEqual({ userId: 'user-9', user: { fullName: 'Ali Rezaei', username: 'ali_r' }, billing: null });
  });
});
