"use client";

import { useLocale } from "@/context/LocaleContext";
import type { AiActionType, AiTypeActivity } from "@/lib/ai-api";
import { K } from "./ai-ui";
import { typeState, type TypeState } from "./ai-settings";
import { Button, StatusPill, Toggle, type Tone } from "../../_components/kit";

const TONE: Record<TypeState["kind"], Tone> = {
  off: "neutral",
  notAvailable: "neutral",
  needsOffer: "warning",
  silenced: "warning",
  partly: "info",
  sent: "success",
  idle: "neutral",
};

interface Props {
  types: readonly AiActionType[];
  disabled: ReadonlySet<AiActionType>;
  /** null while unread or unreadable: rows then say nothing about activity. */
  activity: { windowDays: number; types: AiTypeActivity[] } | null;
  threshold: string;
  onToggle: (type: AiActionType, on: boolean) => void;
  onOpenOffers: () => void;
}

/**
 * Each action type as a switch with what it does in one line and what it has
 * done lately (F-038-j4): sent N times, held back by the chosen level, waiting
 * on a discount offer, or not available yet — from ai's activity (F-038-j3).
 */
export function AiTypeList({ types, disabled, activity, threshold, onToggle, onOpenOffers }: Props) {
  const { t } = useLocale();
  const stateText = (s: TypeState): string => {
    if (s.kind === "sent") return t("common", K.settings.state.sent, { count: s.count });
    if (s.kind === "idle") return t("common", K.settings.state.idle, { days: activity?.windowDays ?? 0 });
    return t("common", K.settings.state[s.kind]);
  };

  return (
    <ul className="grid gap-2 lg:grid-cols-2">
      {types.map((type) => {
        const on = !disabled.has(type);
        const state = typeState(on, activity?.types.find((a) => a.type === type), threshold);
        return (
          <li key={type} data-testid={`ai-type-${type}`} className="flex flex-col gap-1.5">
            <Toggle
              checked={on}
              onChange={(next) => onToggle(type, next)}
              label={
                <span className="flex flex-wrap items-center gap-2">
                  {t("common", K.types[type])}
                  {state && <StatusPill tone={TONE[state.kind]}>{stateText(state)}</StatusPill>}
                </span>
              }
              hint={t("common", K.typeHelp[type])}
            />
            {state?.kind === "needsOffer" && (
              <Button variant="quiet" size="sm" className="self-start" onClick={onOpenOffers}>
                {t("common", K.settings.makeOffer)}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
