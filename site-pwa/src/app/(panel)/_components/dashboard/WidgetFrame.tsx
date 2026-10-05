"use client";

import { AlertCircle, RotateCw } from "lucide-react";
import { Suspense, type ReactNode } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { Button, Card, cn } from "../kit";
import { Skeleton } from "../kit/Skeleton";
import type { WidgetSource } from "./useWidgetSource";

const D = FrontendI18nKeys.common.dashboard;

/** A widget's placeholder: a few lines the height of a typical body. */
export function WidgetSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-busy className="space-y-2.5">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn("h-4", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

/**
 * One widget's card (UX-1-p, D1): a named region with the widget's title, the
 * body loaded lazily behind its own skeleton.
 */
export function WidgetFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card role="region" aria-label={title} className="flex h-full min-w-0 flex-col">
      <h2 className="mb-3 text-sm font-bold text-text-secondary">{title}</h2>
      <div className="min-w-0 flex-1">
        <Suspense fallback={<WidgetSkeleton />}>{children}</Suspense>
      </div>
    </Card>
  );
}

/**
 * A widget's body by its source's state (D1): the skeleton while it loads, a
 * line and a retry when it failed, `empty` when `isEmpty` says the answer holds
 * nothing, else `children` with the data.
 */
export function WidgetBody<T>({
  source,
  skeleton,
  isEmpty,
  empty,
  children,
}: {
  source: WidgetSource<T>;
  skeleton?: ReactNode;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const { t } = useLocale();
  if (source.state === "loading") return <>{skeleton ?? <WidgetSkeleton />}</>;
  if (source.state === "error") {
    return (
      <div className="flex flex-col items-start gap-3 text-sm text-text-secondary">
        <p className="flex items-center gap-2">
          <AlertCircle size={16} aria-hidden className="text-error" />
          {t("common", D.widget.error)}
        </p>
        <Button size="sm" variant="secondary" icon={<RotateCw size={14} aria-hidden />} onClick={source.retry}>
          {t("common", D.widget.retry)}
        </Button>
      </div>
    );
  }
  if (isEmpty?.(source.data) && empty) return <>{empty}</>;
  return <>{children(source.data)}</>;
}
