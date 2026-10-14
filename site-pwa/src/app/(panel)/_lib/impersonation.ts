import type { Me, SwitchGroup } from "@/lib/auth-api";

/**
 * The menu while an admin is signed in as someone (AC-1-i): the account
 * section and the footer's settings alone. Every other section is a staff or
 * reseller route, which an impersonated token never reaches (ADR-0136),
 * whatever the person holds. The person's own acts go too, a group's children
 * included (`ownActOnly`, ADR-0146).
 */
export function impersonationMenu<
  T extends { section?: string; ownActOnly?: true; children?: readonly { ownActOnly?: true }[] },
>(entries: readonly T[]): T[] {
  return entries
    .filter(
      (e) =>
        !e.ownActOnly &&
        (e.section === undefined ||
          e.section === "account" ||
          e.section === "footer"),
    )
    .map((e) =>
      e.children ? { ...e, children: e.children.filter((c) => !c.ownActOnly) } : e,
    );
}

/**
 * The account group while an admin is signed in as someone (AC-1-i): the
 * person alone. Every surface keyed on `group.current` — the greeting, the
 * wallet, notifications, the socket — then follows the person, not the admin
 * whose list `GET /auth/accounts` would answer (and which an impersonated
 * token is refused anyway). No number: `me` carries none, and nobody to switch to.
 */
export function impersonatedGroup(me: Pick<Me, "userId" | "fullName">): SwitchGroup {
  return { groupId: null, current: { userId: me.userId, fullName: me.fullName, phoneMasked: null }, members: [] };
}
