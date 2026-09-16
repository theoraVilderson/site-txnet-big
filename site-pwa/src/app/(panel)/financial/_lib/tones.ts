import {
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  Building2,
  CheckCircle2,
  Clock,
  CreditCard,
  ShieldCheck,
  Store,
  TimerOff,
  type LucideIcon,
} from "lucide-react";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import type { WalletPaymentRow } from "@/lib/billing-api";
import type { Direction, PaymentStatus } from "./filters";

const F = FrontendI18nKeys.common.financial;

/** An icon, a theme class and the key of a translated label. */
export interface Tone {
  icon: LucideIcon;
  className: string;
  /** A `common` namespace key (C-06). The caller translates it. */
  labelKey: string;
}

/**
 * The colours a financial row is read by (F-093-d).
 *
 * Every one of them is a theme token, never a raw Tailwind palette class:
 * three themes ship (`globals.css`) and a hard-coded `emerald-500` is legible
 * in one of them by luck. Legacy mixed the two in the same file, which is why
 * its success badge changed colour with the theme and its failure badge did
 * not.
 */
export const STATUS_TONES: Record<PaymentStatus, Tone> = {
  success: {
    icon: CheckCircle2,
    className: "border-primary/20 bg-leaf-bg text-primary",
    labelKey: F.status.success,
  },
  pending: {
    icon: Clock,
    className: "border-gold/20 bg-gold-bg text-gold",
    labelKey: F.status.pending,
  },
  failed: {
    icon: AlertCircle,
    className: "border-error-border bg-error-bg text-error",
    labelKey: F.status.failed,
  },
  expired: {
    icon: TimerOff,
    className: "border-gold/20 bg-gold-bg text-gold",
    labelKey: F.status.expired,
  },
};

/**
 * A `pending` payment the gateway met with silence and billing is asking again
 * (F-092-x, F-093-m). Not a status of its own — the row stays `pending` — but
 * it must not read "pending": the money may already be taken. Theme green,
 * because the message is "safe", and never gold.
 */
export const VERIFYING_TONE: Tone = {
  icon: ShieldCheck,
  className: "border-primary/20 bg-leaf-bg text-primary",
  labelKey: F.status.verifying,
};

/** The tone a payment row is read by: its status, or verifying. */
export function paymentTone(row: Pick<WalletPaymentRow, "status" | "verifying">): Tone {
  if (row.status === "pending" && row.verifying) return VERIFYING_TONE;
  return STATUS_TONES[row.status] ?? STATUS_TONES.pending;
}

/** Money in and money out. The only two a ledger row can be. */
export const DIRECTION_TONES: Record<Direction, Tone> = {
  credit: {
    icon: ArrowDownLeft,
    className: "border-primary/20 bg-leaf-bg text-primary",
    labelKey: F.direction.credit,
  },
  debit: {
    icon: ArrowUpRight,
    className: "border-error-border bg-error-bg text-error",
    labelKey: F.direction.debit,
  },
};

/**
 * Whose gateway took the money — the platform's or this tenant's. It is shown
 * because a reseller's support desk is asked about their own gateway and the
 * platform's desk about the platform's, and the receipt has to say which
 * (ADR-0006). `null` is a payment with no gateway row left to name.
 */
export const GATEWAY_TONES: Record<"platform" | "tenant" | "none", Tone> = {
  platform: {
    icon: Building2,
    className: "border-card-border bg-bg-inner text-text-secondary",
    labelKey: F.gatewaySource.platform,
  },
  tenant: {
    icon: Store,
    className: "border-card-border bg-bg-inner text-text-secondary",
    labelKey: F.gatewaySource.tenant,
  },
  none: {
    icon: CreditCard,
    className: "border-card-border bg-bg-inner text-text-secondary",
    labelKey: F.gatewaySource.none,
  },
};

/** A reason type's label key. A value the API adds later renders as itself rather than as nothing. */
export function reasonLabelKey(reasonType: string): string | null {
  const keys = F.reason as Record<string, string | undefined>;
  return keys[reasonType] ?? null;
}
