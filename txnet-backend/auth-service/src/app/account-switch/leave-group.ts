import { PrismaService } from '../prisma/prisma.service';

/**
 * Take one member out of its switch group, and tear the group down once it
 * would be left with a single member: a group of one is not a switcher, and
 * leaving it standing means the next add finds a stale group instead of
 * creating a fresh one.
 *
 * One transaction, so no reader sees a group with a hole in it. Shared by the
 * two ways an account leaves a place's group: being removed from the switcher
 * (F-0208) and having that place's session ended from another device
 * (SES-1-a).
 */
export async function leaveGroup(
  prisma: PrismaService,
  member: { id: string; groupId: string },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.linkedAccountMember.delete({ where: { id: member.id } });

    const left = await tx.linkedAccountMember.findMany({
      where: { groupId: member.groupId },
      select: { id: true },
    });
    if (left.length <= 1) {
      await tx.linkedAccountMember.deleteMany({ where: { groupId: member.groupId } });
      await tx.linkedAccountGroup.delete({ where: { id: member.groupId } });
    }
  });
}
