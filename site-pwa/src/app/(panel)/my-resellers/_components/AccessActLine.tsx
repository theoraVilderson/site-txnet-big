"use client";

import { useLocale } from "@/context/LocaleContext";
import type { NamedActor } from "@/lib/auth-api";
import { Badge } from "../../_components/kit";
import { formatInstant } from "../../_lib/datetime";
import { ACCESS_HISTORY_KEYS as K, actSentence } from "../_lib/access-history";

type Props = {
  /** The act, or null for the person's own (a seat accepted). */
  act: Parameters<typeof actSentence>[0] | null;
  at: string;
  actor: NamedActor;
  reason: string | null;
  given: string[];
  taken: string[];
  /** A key by its registry label (AC-1-f). */
  label: (key: string) => string;
  /** The tenant's log: how many people the act moved. */
  moved?: number;
};

/**
 * One line of access history (AC-1-p), the same in a person's history and the
 * tenant's log: the act as a sentence, who and when, the reason, and the keys
 * gained and lost.
 */
export function AccessActLine({ act, at, actor, reason, given, taken, label, moved }: Props) {
  const { t, lang } = useLocale();
  const sentence = act ? actSentence(act) : { key: K.acts.seat_joined, params: {} as Record<string, string> };
  const params = { ...sentence.params };
  if ("key" in params) params.key = label(params.key);
  if ("end" in params) params.end = (params.end && formatInstant(params.end, lang, { withTime: false })) || t("common", K.noEnd);

  return (
    <li className="space-y-1 px-3 py-2 text-xs">
      <p className="font-bold text-text-primary" dir="auto">
        {t("common", sentence.key, params)}
      </p>
      <p className="flex flex-wrap gap-x-3 text-text-secondary">
        <span>{formatInstant(at, lang)}</span>
        <span dir="auto">{t("common", K.by, { actor: actor.name ?? t("common", K.someone) })}</span>
        {moved !== undefined && moved > 0 && <span>{t("common", K.moved, { count: moved })}</span>}
      </p>
      {reason && (
        <p className="text-text-secondary" dir="auto">
          {t("common", K.reason, { reason })}
        </p>
      )}
      {(given.length > 0 || taken.length > 0) && (
        <p className="flex flex-wrap items-center gap-1">
          {given.map((key) => (
            <Badge key={`+${key}`} tone="success">
              {t("common", K.gained)}: {label(key)}
            </Badge>
          ))}
          {taken.map((key) => (
            <Badge key={`-${key}`} tone="error">
              {t("common", K.lost)}: {label(key)}
            </Badge>
          ))}
        </p>
      )}
    </li>
  );
}
