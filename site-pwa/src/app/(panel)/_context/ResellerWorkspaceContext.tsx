"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import type { OwnedReseller } from "@/lib/auth-api";
import { useResellerSetup } from "../_hooks/useResellerSetup";
import { workspaceOfPath, type Workspace } from "../_lib/reseller-menu";
import type { SetupProgress } from "../my-resellers/_lib/setup";
import { resellerDomainOf, selfResellerOf, useOwnedResellerList } from "../my-resellers/_lib/workspace";
import { usePanelSession } from "./PanelSessionContext";

/**
 * Whose reseller the panel is showing — decided once, here, and read by
 * everything that has to say it: the menu and the palette (`useVisibleMenu`),
 * the page header's scope tag and its breadcrumb (`PageHeader`), the handoff
 * (UX-2-a, UX-2-a2; `contract.reseller-workspace.md`). A page never says it
 * itself, so a new workspace page is labelled without opting in, and no two
 * places can disagree.
 */
export interface ResellerWorkspaceState {
  /** The reseller whose links the one menu carries, or `null`: the account's alone. */
  workspace: Workspace | null;
  /** The address is inside that workspace: its pages are the reseller's, not the platform's. */
  inPath: boolean;
  /** Its slug, when the caller owns it; `null` for staff opening another one. */
  slug: string | null;
  /** The caller's owned resellers (`GET /auth/handoff`); `null` until it answers. */
  owned: readonly OwnedReseller[] | null;
  /** On a reseller's own domain: no handoff, nowhere to hand off to (F-061-m). */
  onResellerDomain: boolean;
  /** How far that reseller is set up — the menu's setup row (UX-2-e); `null` until it answers. */
  setup: SetupProgress | null;
  /** A page saved something setup counts: read it again now. */
  rereadSetup: () => void;
}

const NONE: ResellerWorkspaceState = { workspace: null, inPath: false, slug: null, owned: null, onResellerDomain: false, setup: null, rereadSetup: () => undefined };

const ResellerWorkspaceContext = createContext<ResellerWorkspaceState>(NONE);

/**
 * Whose reseller (UX-2-a): the workspace the address is inside — staff opening
 * a reseller by id get that one — else the caller's own (`/reseller`), else,
 * for an owner whose one reseller is terminated, that one by id. On a
 * reseller's domain only its own `/reseller` counts (a `/my-resellers` address
 * there is the 404, `PlatformOnlyWorkspace`); the platform's own users page
 * shares the `/my-resellers` address and is the platform's (`workspaceOfPath`).
 * Nothing is stored. Until `me` and the owned list answer, there is none.
 */
export function ResellerWorkspaceProvider({ children }: { children: ReactNode }) {
  const { me } = usePanelSession();
  const pathname = usePathname() ?? "";
  const owned = useOwnedResellerList();
  const selfId = selfResellerOf(me, owned);
  const domain = resellerDomainOf(me, owned);
  const fromPath = me ? workspaceOfPath(pathname, me, selfId) : null;
  const inPath = fromPath !== null && (fromPath.self || domain === null);
  let workspace: Workspace | null = inPath ? fromPath : null;
  if (!workspace && typeof selfId === "string") workspace = { id: selfId, self: true };
  if (!workspace && domain === null && owned && owned.length > 0) workspace = { id: owned[0].id, self: false };
  const wsId = workspace?.id ?? null;
  const wsSelf = workspace?.self ?? false;
  const slug = (wsId && owned?.find((r) => r.id === wsId)?.slug) || null;
  const onResellerDomain = typeof domain === "string";
  // Setup progress and the gate's celebration live here, once, for whichever
  // page is open (UX-2-e).
  const { setup, reread: rereadSetup } = useResellerSetup(wsId);
  const value = useMemo<ResellerWorkspaceState>(
    () => ({ workspace: wsId === null ? null : { id: wsId, self: wsSelf }, inPath, slug, owned, onResellerDomain, setup, rereadSetup }),
    [wsId, wsSelf, inPath, slug, owned, onResellerDomain, setup, rereadSetup],
  );
  return <ResellerWorkspaceContext.Provider value={value}>{children}</ResellerWorkspaceContext.Provider>;
}

/** The provider's answer; outside it (a component rendered alone), no reseller. */
export function useResellerWorkspace(): ResellerWorkspaceState {
  return useContext(ResellerWorkspaceContext);
}
