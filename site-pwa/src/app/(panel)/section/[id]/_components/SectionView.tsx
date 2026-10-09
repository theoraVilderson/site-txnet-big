"use client";

import Link from "next/link";
import { notFound } from "next/navigation";
import { useLocale } from "@/context/LocaleContext";
import { PageHeader } from "../../../_components/kit";
import { TableSkeleton } from "../../../_components/kit/TableSkeleton";
import { usePanelSession } from "../../../_context/PanelSessionContext";
import { useVisibleMenu } from "../../../_hooks/useVisibleMenu";
import { MENU_SECTIONS, isMenuGroup, menuSections, type VisibleMenuLink } from "../../../_lib/panel-menu";

/**
 * One menu section as a page (user, 2026-10-09): the caller's visible entries
 * in it, in the sidebar's order — a link as a card, a group as a heading
 * (`#<group id>`, where its crumb lands) over its children's cards. Built from
 * the menu, so a new entry appears here with no change; an unknown section,
 * or one the caller sees nothing in, is the panel's 404.
 */
export function SectionView({ id }: { id: string }) {
  const { t } = useLocale();
  const { me } = usePanelSession();
  const menu = useVisibleMenu();
  const known = MENU_SECTIONS.find((s) => s.id === id);
  if (!known) notFound();
  if (!me)
    return (
      <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
        <TableSkeleton rows={4} columns={2} />
      </div>
    );
  const section = menuSections(menu).find((s) => s.id === id);
  if (!section) notFound();

  const links = section.entries.filter((e): e is VisibleMenuLink => !isMenuGroup(e));
  const groups = section.entries.filter(isMenuGroup);
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
      <PageHeader title={t("common", known.label)} />
      {links.length > 0 && <Cards links={links} />}
      {groups.map((g) => (
        <section key={g.id} id={g.id} aria-labelledby={`${g.id}-heading`} className="scroll-mt-20 space-y-3">
          <h2 id={`${g.id}-heading`} className="flex items-center gap-2 text-base font-bold text-text-primary">
            <g.icon size={16} className="text-primary" aria-hidden />
            {t("common", g.label)}
          </h2>
          <Cards links={g.children} />
        </section>
      ))}
    </div>
  );
}

function Cards({ links }: { links: readonly VisibleMenuLink[] }) {
  const { t } = useLocale();
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {links.map((l) => (
        <li key={l.id}>
          <Link
            href={l.href}
            className="flex items-center gap-3 rounded-2xl border border-card-border bg-card-bg p-4 text-sm font-bold text-text-primary transition-colors hover:border-primary/40 hover:text-primary"
          >
            <l.icon size={18} className="shrink-0 text-primary" aria-hidden />
            {t("common", l.label)}
          </Link>
        </li>
      ))}
    </ul>
  );
}
