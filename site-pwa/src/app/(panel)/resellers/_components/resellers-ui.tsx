"use client";

import { AlertCircle, CheckCircle2, Clock, XCircle, type LucideIcon } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import type { TenantStatus } from "@/lib/tenant-api";
import { Badge } from "../../financial/_components/Badge";
import { RESELLER_KEYS, refusalKey } from "../_lib/resellers";

// The sheet, field and button styles are the catalog page's; they hold no
// catalog rule, and a second copy would drift.
export { Alert, Field, Sheet, input, primaryButton, quietButton } from "../../catalog/_components/catalog-ui";

/** The refusal's own sentence, else the generic answer for that error. */
export function useMessage() {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  return (e: unknown) => {
    const key = refusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };
}

const STATUS_TONE: Record<TenantStatus, { icon: LucideIcon; className: string }> = {
  trial: { icon: Clock, className: "border-gold/20 bg-gold-bg text-gold" },
  active: { icon: CheckCircle2, className: "border-primary/20 bg-leaf-bg text-primary" },
  suspended: { icon: AlertCircle, className: "border-gold/20 bg-gold-bg text-gold" },
  terminated: { icon: XCircle, className: "border-error-border bg-error-bg text-error" },
};

/** A reseller's status, wherever it is shown — the list and its page read the same tone. */
export function StatusBadge({ status }: { status: TenantStatus }) {
  const { t } = useLocale();
  return <Badge {...STATUS_TONE[status]} label={t("common", RESELLER_KEYS.status[status])} />;
}
