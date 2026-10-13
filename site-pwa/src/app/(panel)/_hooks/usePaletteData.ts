"use client";

import { Globe, Headphones, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api-error";
import { authApi, resellerUsersApi, type Me } from "@/lib/auth-api";
import { billingApi } from "@/lib/billing-api";
import { PANEL_MY_SERVICES, panelMyServicesSearchPath, panelUserPath, panelSupportThreadPath } from "@/lib/routes";
import { supportApi } from "@/lib/support-api";
import { isMenuGroup, type VisibleMenuEntry } from "../_lib/panel-menu";
import { PALETTE_GROUP_LIMIT, type PaletteDataGroup, type PaletteItem } from "../_lib/palette";
import { STATUS_KEYS } from "../support/_lib/support";
import { pastedLines } from "../services/_lib/my-services";
import { isPlatformTenant } from "@/lib/tenant-type";

/** N7: a source is asked once typing has rested this long, and only from this many characters. */
export const PALETTE_DATA_DEBOUNCE_MS = 300;
export const PALETTE_DATA_MIN = 2;
/** Both user searches refuse fewer than 3 (auth-api `GET /auth/users`, F-311-a's `q`). */
const USERS_MIN = 3;

type Translate = (ns: string, key: string, vars?: Record<string, string | number>) => string;

interface Source {
  group: PaletteDataGroup;
  min: number;
  ask: (q: string) => Promise<PaletteItem[]>;
}

/**
 * Groups a source refused with 403, by user — hidden for the rest of this
 * page's life (N7), so a caller without the permission is not asked again on
 * every pause in their typing. Another user's refusal is not this one's.
 */
const refused = new Set<string>();

/** A spec's clean slate. */
// codeshape: spec-only — the refused-source set is module state; each spec starts clean
export function resetPaletteDataForTests(): void {
  refused.clear();
}

/**
 * The sources the caller may ask (UX-1-o, `contract.ux.md` N7). A query
 * holding `://` is a pasted config — a credential — so it goes only to
 * billing's `by-lines`, in a body, and no other source sees it.
 */
function sourcesFor(me: Me | null, menu: readonly VisibleMenuEntry[], pasted: boolean, t: Translate): Source[] {
  if (!me) return [];
  const sources: Source[] = [
    {
      group: "services",
      min: PALETTE_DATA_MIN,
      ask: async (q) => {
        const lines = pasted ? pastedLines(q).lines : [];
        if (pasted && lines.length === 0) return [];
        const page = pasted
          ? await billingApi.grantsByLines(lines, 1, PALETTE_GROUP_LIMIT, "all")
          : await billingApi.grants(1, PALETTE_GROUP_LIMIT, "all", q);
        return page.rows.map((g) => {
          const name = g.label ?? g.variant?.sku ?? g.id.slice(0, 8);
          return {
            key: `services:${g.id}`,
            group: "services",
            label: name,
            icon: Globe,
            haystacks: [],
            // The search that found it; for a pasted link, the service's own name instead.
            href: pasted ? (g.label ? panelMyServicesSearchPath(g.label) : PANEL_MY_SERVICES) : panelMyServicesSearchPath(q),
          } satisfies PaletteItem;
        });
      },
    },
  ];
  if (pasted) return sources;

  sources.push({
    group: "tickets",
    min: PALETTE_DATA_MIN,
    ask: async (q) =>
      (await supportApi.search(q, PALETTE_GROUP_LIMIT)).items.map((c) => ({
        key: `tickets:${c.id}`,
        group: "tickets",
        label: c.subject,
        hint: t("common", STATUS_KEYS[c.status]),
        icon: Headphones,
        haystacks: [],
        href: panelSupportThreadPath(c.id),
      })),
  });

  // Only where the users page itself is in the caller's menu, so a hit always opens.
  const usersPage = menu.some((e) => !isMenuGroup(e) && e.id === "users");
  if (usersPage) {
    const tenantId = me.tenant.id;
    sources.push({
      group: "users",
      min: USERS_MIN,
      ask: async (q) => {
        const hits = isPlatformTenant(me.tenant.type) ? (await authApi.searchUsers(q)).users : (await resellerUsersApi.list(tenantId, { q, page: 1, pageSize: PALETTE_GROUP_LIMIT })).items;
        return hits.slice(0, PALETTE_GROUP_LIMIT).map((u) => ({
          key: `users:${u.id}`,
          group: "users",
          label: u.fullName,
          hint: [u.username && `@${u.username}`, u.phoneMasked].filter(Boolean).join(" · ") || undefined,
          icon: UserRound,
          haystacks: [],
          href: panelUserPath(u.id),
        }));
      },
    });
  }
  return sources;
}

/**
 * The palette's data groups for `query` (UX-1-o): each source asked on its own
 * once typing has rested 300ms, so a slow one never holds the others back.
 * Answers are kept by the query they answer; one for an older query is never
 * shown. A 403 hides the group for the session; any other failure shows the
 * group as empty, this time only.
 */
export function usePaletteData(
  query: string,
  me: Me | null,
  menu: readonly VisibleMenuEntry[],
  t: Translate,
): { items: PaletteItem[]; searching: boolean } {
  const q = query.trim();
  const [answers, setAnswers] = useState<{ q: string; group: PaletteDataGroup; items: PaletteItem[] | null }[]>([]);
  const userId = me?.userId ?? "";

  useEffect(() => {
    const sources = sourcesFor(me, menu, q.includes("://"), t).filter(
      (s) => q.length >= s.min && !refused.has(`${userId}:${s.group}`),
    );
    if (sources.length === 0) return;
    let live = true;
    const timer = setTimeout(() => {
      // `null` while asked: the group's "searching" line.
      if (live) setAnswers(sources.map((s) => ({ q, group: s.group, items: null })));
      for (const source of sources) {
        source
          .ask(q)
          .catch((e: unknown) => {
            if (e instanceof ApiError && e.status === 403) refused.add(`${userId}:${source.group}`);
            return [];
          })
          .then((items) => {
            if (live) setAnswers((all) => all.map((a) => (a.q === q && a.group === source.group ? { ...a, items } : a)));
          });
      }
    }, PALETTE_DATA_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // `t` is a new function each render; the sources it names do not change with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, me, menu, userId]);

  const current = answers.filter((a) => a.q === q && !refused.has(`${userId}:${a.group}`));
  return {
    items: current.flatMap((a) => a.items ?? []),
    searching: current.some((a) => a.items === null),
  };
}
