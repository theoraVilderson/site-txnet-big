"use client";

import { usePanelUiStore } from "../_stores/panel-ui-store";
import { PanelSidebar } from "./PanelSidebar";
import { PanelTopBar } from "./PanelTopBar";

/**
 * The frame every panel page renders inside (F-093-a): the sidebar at the
 * inline start, and a column beside it holding the top bar and the page. The
 * column's margin follows the sidebar's width from `lg` up; below that the
 * sidebar is a drawer over the page and takes no room.
 */
export function PanelShell({ children }: { children: React.ReactNode }) {
  const collapsed = usePanelUiStore((s) => s.collapsed);

  return (
    <div className="relative min-h-screen w-full transition-colors duration-500">
      <PanelSidebar />
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
