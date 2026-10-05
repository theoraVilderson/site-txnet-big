"use client";

import { motion } from "framer-motion";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { DURATION, EASE } from "@/lib/motion";
import { cn } from "./cn";

export interface TabItem<V extends string = string> {
  value: V;
  label: ReactNode;
  icon?: ReactNode;
  /** A count after the label. */
  badge?: ReactNode;
}

export interface TabsProps<V extends string = string> {
  ariaLabel: string;
  tabs: readonly TabItem<V>[];
  /** Controlled. Ignored when `urlParam` is set — the URL holds it then. */
  value?: V;
  onChange?: (value: V) => void;
  /** Keeps the tab in `?<param>=` (`/settings?tab=`); a value naming no tab reads as the first. */
  urlParam?: string;
  /**
   * `line`: an underline. `pills`: scrolling pills, for a phone (S2). `side`:
   * pills below `lg`, and from `lg` a 240px column of tabs at the start side
   * with the panel beside it (settings, S2).
   */
  variant?: "line" | "pills" | "side";
  /** The panel for the active tab; without it the bar is only a bar. */
  children?: (active: V) => ReactNode;
  className?: string;
}

/**
 * A tab bar whose indicator slides (UX-1-d, `contract.ux.md` K8). The arrows
 * move and select (left/right by reading direction), Home and End jump, and
 * only the selected tab is a tab stop.
 */
export function Tabs<V extends string = string>(props: TabsProps<V>) {
  return props.urlParam ? <UrlTabs {...props} urlParam={props.urlParam} /> : <LocalTabs {...props} />;
}

function LocalTabs<V extends string>(props: TabsProps<V>) {
  const [own, setOwn] = useState<V>(props.tabs[0]?.value);
  const value = props.value ?? own;
  return (
    <TabsView
      {...props}
      active={value}
      select={(v) => {
        setOwn(v);
        props.onChange?.(v);
      }}
    />
  );
}

function UrlTabs<V extends string>(props: TabsProps<V> & { urlParam: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const asked = params.get(props.urlParam);
  const active = props.tabs.find((t) => t.value === asked)?.value ?? props.tabs[0]?.value;
  return (
    <TabsView
      {...props}
      active={active}
      select={(v) => {
        const next = new URLSearchParams(params.toString());
        next.set(props.urlParam, v);
        router.replace(`${pathname}?${next.toString()}`, { scroll: false });
        props.onChange?.(v);
      }}
    />
  );
}

function TabsView<V extends string>({ ariaLabel, tabs, variant = "line", children, className, active, select }: TabsProps<V> & { active: V; select: (v: V) => void }) {
  const id = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const rtl = e.currentTarget.closest("[dir]")?.getAttribute("dir") === "rtl";
    const last = tabs.length - 1;
    // A side column is also walked by up and down.
    const forward = e.key === (rtl ? "ArrowLeft" : "ArrowRight") || (side && e.key === "ArrowDown");
    const back = e.key === (rtl ? "ArrowRight" : "ArrowLeft") || (side && e.key === "ArrowUp");
    const next =
      forward
        ? (index + 1) % tabs.length
        : back
          ? (index - 1 + tabs.length) % tabs.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? last
              : -1;
    if (next < 0) return;
    e.preventDefault();
    select(tabs[next].value);
    refs.current[next]?.focus();
  };

  const side = variant === "side";
  const pills = variant === "pills" || side;
  return (
    <div className={cn(side && "lg:grid lg:grid-cols-[240px_minmax(0,1fr)] lg:items-start lg:gap-8", className)}>
      <div
        role="tablist"
        aria-label={ariaLabel}
        className={cn(
          "flex gap-1 overflow-x-auto [scrollbar-width:none]",
          pills ? "pb-1" : "border-b border-card-border",
          side && "lg:sticky lg:top-24 lg:flex-col lg:overflow-visible lg:pb-0",
        )}
      >
        {tabs.map((tab, i) => {
          const selected = tab.value === active;
          return (
            <button
              key={tab.value}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${id}-tab-${i}`}
              aria-selected={selected}
              aria-controls={children ? `${id}-panel` : undefined}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(tab.value)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn(
                "relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-sm font-bold transition-colors",
                pills ? "h-9 rounded-full px-3.5" : "h-10 px-3",
                side && "lg:h-10 lg:w-full lg:rounded-xl lg:px-3",
                selected ? (pills ? "text-on-accent" : "text-primary") : "text-text-secondary hover:text-text-primary",
              )}
            >
              {selected && (
                <motion.span
                  layoutId={`${id}-indicator`}
                  aria-hidden
                  className={pills ? cn("absolute inset-0 rounded-full bg-primary", side && "lg:rounded-xl") : "absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-primary"}
                  transition={{ duration: DURATION.base, ease: EASE.standard }}
                />
              )}
              {tab.icon && <span className="relative [&>svg]:size-4">{tab.icon}</span>}
              <span className="relative">{tab.label}</span>
              {tab.badge !== undefined && tab.badge !== null && (
                <span className={cn("relative rounded-full px-1.5 text-[11px] tabular-nums", selected && pills ? "bg-black/10" : "bg-leaf-bg")}>{tab.badge}</span>
              )}
            </button>
          );
        })}
      </div>
      {children && (
        <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${Math.max(0, tabs.findIndex((t) => t.value === active))}`} tabIndex={0} className={cn("mt-4 min-w-0 focus:outline-none", side && "lg:mt-0")}>
          {children(active)}
        </div>
      )}
    </div>
  );
}
