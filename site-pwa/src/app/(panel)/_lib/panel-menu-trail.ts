import { panelSectionPath } from "@/lib/routes";
import { MENU_SECTIONS, isMenuGroup, type PanelMenuEntry, type PanelMenuLink } from "./panel-menu";

/*
 * Where a path sits in the menu (UX-1-i, UX-1-j): the entry to highlight and
 * the breadcrumb down to it. Apart from `panel-menu.ts`, which says what the
 * menu holds and who sees it (C-20: split by job).
 */

const trimSlash = (path: string) =>
  path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

/**
 * The one href to highlight for `pathname`: the longest menu href that is the
 * path itself or a whole-segment prefix of it. Longest, because `/` prefixes
 * everything and a group's own page prefixes its siblings; whole-segment, so
 * `/financial/deposits` does not light up `/financial/deposit`.
 */
export function activeHref(
  hrefs: readonly string[],
  pathname: string,
): string | null {
  const path = trimSlash(pathname);
  let best: string | null = null;
  for (const raw of hrefs) {
    const href = trimSlash(raw);
    const matches =
      href === "/" || path === href || path.startsWith(`${href}/`);
    if (matches && (best === null || href.length > best.length)) best = href;
  }
  return best;
}

export interface MenuCrumb {
  /** A `common` namespace key. */
  label: string;
  /** A section's page, a group's heading on it; `null` only outside every section. */
  href: string | null;
  /** A section's heading (UX-1-j) — drawn only beside a trail that is drawn anyway. */
  section?: true;
}

/**
 * The breadcrumb trail for `pathname` (UX-1-i, `contract.ux.md` K14): the menu
 * tree from the top down to the entry `activeHref` would light up — its
 * section (UX-1-j; none for the footer), a group, then its page. Empty on a path no entry owns. It reads the whole menu, not
 * the caller's visible one: whoever is on the page may see where it sits.
 *
 * An `href` that is a function of a tenant id is matched with any one segment
 * in the id's place, and the crumb links to the segment the path holds — the
 * tenant the page is already on, so no session is needed to draw it.
 */
export function menuTrail(
  entries: readonly PanelMenuEntry[],
  pathname: string,
): MenuCrumb[] {
  const hrefOf = (l: PanelMenuLink) => {
    if (typeof l.href !== "function") return l.href;
    // A reseller's own domain addresses it with no id at all (F-061-n).
    const self = l.href("TENANTPROBE", true);
    if (
      !self.includes("TENANTPROBE") &&
      (pathname === self || pathname.startsWith(`${self}/`))
    )
      return self;
    // An address with no id at all (`/users`): it is the path or it is not.
    if (!l.href("TENANTPROBE", false).includes("TENANTPROBE")) return null;
    // Letters only, so a path builder that encodes its id hands the probe back unchanged.
    const [before, after] = l.href("TENANTPROBE", false).split("TENANTPROBE");
    const escape = (part: string) =>
      part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (
      pathname.match(
        new RegExp(`^${escape(before)}[^/]+${escape(after)}(?=/|$)`),
      )?.[0] ?? null
    );
  };
  const trails: { href: string; trail: MenuCrumb[] }[] = [];
  for (const entry of entries) {
    const placed = entry.section ?? "account";
    const section = MENU_SECTIONS.find((s) => s.id === placed);
    const top: MenuCrumb[] = section
      ? [
          {
            label: section.label,
            href: panelSectionPath(section.id),
            section: true,
          },
        ]
      : [];
    if (isMenuGroup(entry)) {
      for (const child of entry.children) {
        const href = hrefOf(child);
        if (href)
          trails.push({
            href,
            trail: [
              ...top,
              {
                label: entry.label,
                href: section ? panelSectionPath(section.id, entry.id) : null,
              },
              { label: child.label, href },
            ],
          });
      }
    } else {
      const href = hrefOf(entry);
      if (href)
        trails.push({ href, trail: [...top, { label: entry.label, href }] });
    }
  }
  const active = activeHref(
    trails.map((t) => t.href),
    pathname,
  );
  if (active === null) return [];
  // `/` is the dashboard's own href and prefixes every path: only the dashboard itself is in it.
  if (active === "/" && trimSlash(pathname) !== "/") return [];
  return trails.find((t) => trimSlash(t.href) === active)?.trail ?? [];
}
