"use client";

import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { PANEL_MENU, menuTrail } from "../../_lib/panel-menu";
import { cn } from "./cn";

const K = FrontendI18nKeys.common.kit.pageHeader;

export interface PageHeaderProps {
  title: ReactNode;
  /** One line under the title. */
  subtitle?: ReactNode;
  icon?: LucideIcon;
  /** Buttons at the end of the title row. */
  actions?: ReactNode;
  /**
   * The page's own last crumb, below a menu page — a reseller's slug on
   * `/resellers/:id`. With it the menu page becomes a link back.
   */
  tail?: string;
  className?: string;
}

/**
 * A page's title row (UX-1-i, `contract.ux.md` K14): title, a subtitle, the
 * actions at the end, and above them the breadcrumb trail from `md` up — the
 * menu tree to this page (`menuTrail`) and the page's own `tail`. Below `md`
 * the trail is one back link to the nearest crumb that is a page. A page alone
 * in its section, with no group and no tail, has no trail to show.
 */
export function PageHeader({ title, subtitle, icon: Icon, actions, tail, className }: PageHeaderProps) {
  const { t, isRtl } = useLocale();
  // `null` outside the App Router (a page rendered alone in a spec): no trail.
  const pathname = usePathname() ?? "";

  const crumbs = [
    ...menuTrail(PANEL_MENU, pathname).map((c) => ({ label: t("common", c.label), href: c.href, section: c.section })),
    ...(tail ? [{ label: tail, href: null, section: undefined }] : []),
  ];
  // A section's name alone before the page is not a trail (UX-1-j): one is
  // drawn when a group or a tail makes two crumbs besides it.
  const drawn = crumbs.filter((c) => !c.section).length > 1;
  const last = crumbs.length - 1;
  const back = crumbs.slice(0, last).reverse().find((c) => c.href !== null);
  const Separator = isRtl ? ChevronLeft : ChevronRight;
  const BackIcon = isRtl ? ArrowRight : ArrowLeft;

  return (
    <header className={cn("flex flex-col gap-2", className)}>
      {drawn && (
        <nav aria-label={t("common", K.breadcrumb)} className="hidden md:block">
          <ol className="flex flex-wrap items-center gap-1 text-xs text-text-secondary">
            {crumbs.map((c, i) => (
              <li key={`${i}-${c.label}`} className="flex items-center gap-1">
                {i > 0 && <Separator size={12} aria-hidden className="opacity-60" />}
                {i === last ? (
                  <span aria-current="page" className="font-bold text-text-primary">
                    {c.label}
                  </span>
                ) : c.href ? (
                  <Link href={c.href} className="rounded-md hover:text-primary hover:underline">
                    {c.label}
                  </Link>
                ) : (
                  <span>{c.label}</span>
                )}
              </li>
            ))}
          </ol>
        </nav>
      )}
      {back?.href && (
        <Link href={back.href} className="inline-flex w-fit items-center gap-1 text-xs font-bold text-text-secondary hover:text-primary md:hidden">
          <BackIcon size={14} aria-hidden />
          <span className="sr-only">{t("common", K.back, { page: back.label })}</span>
          <span aria-hidden>{back.label}</span>
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-bold text-text-primary md:text-3xl">
            {Icon && <Icon size={22} className="shrink-0 text-primary" aria-hidden />}
            {title}
          </h1>
          {subtitle && <p className="mt-1 text-sm text-text-secondary">{subtitle}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
