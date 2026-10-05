"use client";

import { Suspense } from "react";
import { useUiPreferences } from "@/stores/ui-preferences-store";
import { CommandPalette } from "./CommandPalette";
import { PanelSidebar } from "./PanelSidebar";
import { PanelTopBar } from "./PanelTopBar";
import { RouteProgress } from "./RouteProgress";

/**
 * The frame every panel page renders inside (F-093-a): the sidebar at the
 * inline start, and a column beside it holding the top bar and the page. The
 * column's margin follows the sidebar's width from `lg` up; below that the
 * sidebar is a drawer over the page and takes no room. The command palette
 * (UX-1-n) is mounted here once, so Ctrl/⌘+K works on every page.
 */
export function PanelShell({ children }: { children: React.ReactNode }) {
  // The person's own `ui.sidebar.collapsed` (UX-1-l), not this tab's.
  const collapsed = useUiPreferences((s) => s.prefs["ui.sidebar"].collapsed);

  return (
    <div className="relative min-h-screen w-full transition-colors duration-500">
      {/* UX-1-i: the bar a navigation runs at the top (M4). Suspense, because it reads the query. */}
      <Suspense fallback={null}>
        <RouteProgress />
      </Suspense>
      <PanelSidebar />
      <CommandPalette />
      <div
        className={`flex min-h-screen flex-col transition-[margin] duration-300 ease-[cubic-bezier(0.25,0.8,0.25,1)] ${
          collapsed ? "lg:ms-20" : "lg:ms-72"
        }`}
      >
        <PanelTopBar />
        <main className="relative z-10 w-full flex-1">{children}</main>
      </div>
    </div>
  );
}
