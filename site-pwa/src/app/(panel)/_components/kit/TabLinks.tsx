"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cn } from "./cn";

export interface TabLink {
  href: string;
  label: ReactNode;
  icon?: ReactNode;
  /** Active only on this exact path, not below it — an overview whose siblings live under it. */
  exact?: boolean;
}

/** Whether `href` is the page at `pathname`, or (unless `exact`) a page above it. */
export function isActiveLink(pathname: string, href: string, exact = false): boolean {
  const path = pathname.replace(/\/+$/, "");
  const target = href.replace(/\/+$/, "");
  return exact ? path === target : path === target || path.startsWith(`${target}/`);
}

/**
 * A tab bar of links (`contract.ux.md` K8, N8): the kit `Tabs` pills for pages
 * that are their own routes. Each tab is a link, so it opens in a new tab and
 * survives a reload; the one for this page is `aria-current="page"`. When two
 * links match, the longest wins — `…/catalog/translations` is the catalog's.
 */
export function TabLinks({ ariaLabel, links, className }: { ariaLabel: string; links: readonly TabLink[]; className?: string }) {
  const pathname = usePathname() ?? "";
  const matching = links.filter((l) => isActiveLink(pathname, l.href, l.exact));
  const active = matching.sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <nav aria-label={ariaLabel} className={cn("flex gap-1 overflow-x-auto pb-1 [scrollbar-width:none]", className)}>
      {links.map((link) => {
        const current = link.href === active;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={current ? "page" : undefined}
            className={cn(
              "inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-sm font-bold transition-colors",
              current ? "bg-primary text-on-accent" : "text-text-secondary hover:bg-leaf-bg hover:text-text-primary",
            )}
          >
            {link.icon && <span className="[&>svg]:size-4">{link.icon}</span>}
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
