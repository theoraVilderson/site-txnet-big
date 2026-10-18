"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, RotateCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { lotteryAdminApi, type AdminLottery, type LotteryEligibility, type LotteryWinners } from "@/lib/engagement-api";
import { PANEL_LOTTERIES_MANAGE } from "@/lib/routes";
import { usePanelSession } from "../../../_context/PanelSessionContext";
import { formatInstant } from "../../../_lib/datetime";
import { TableSkeleton } from "../../../_components/kit/TableSkeleton";
import { Field } from "../../../catalog/_components/catalog-ui";
import { passedOnKeyOf } from "../../_lib/lotteries";
import { LOTTERY_ADMIN_KEYS as K, REASON_MAX, actionsFor, canManageLotteries, excludedCountKeyOf } from "../_lib/lottery-admin";
import { useAudienceGroups } from "../../../_hooks/useAudienceGroups";
import { LotteryWizard } from "./LotteryWizard";
import { StatusPill, useLotteryMessage } from "./lottery-admin-ui";
import { PageHeader } from "../../../_components/kit/PageHeader";
import { Alert, Button, Textarea, buttonClass } from "../../../_components/kit";

type Confirming = "publish" | "remove" | "cancel" | null;

/**
 * One lottery, for its admin (F-707-o): what it is, the acts billing allows in
 * its status (F-707-i rules 1–3), who enters (an estimate until the freeze,
 * then the frozen list), and once drawn, who holds each place and whether the
 * prize reached them (F-707-m). Nothing here closes or draws: that is the
 * worker's alone.
 */
export function LotteryAdminDetail({ id }: { id: string }) {
  const { lang, t } = useLocale();
  const router = useRouter();
  const { me, isLoading: sessionLoading } = usePanelSession();
  const message = useLotteryMessage();
  const allowed = canManageLotteries(me);

  const [lottery, setLottery] = useState<AdminLottery | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    lotteryAdminApi
      .get(id)
      .then((l) => {
        if (!alive) return;
        setLottery(l);
        setError(null);
      })
      .catch((e) => {
        if (alive) setError(e);
      });
    return () => {
      alive = false;
    };
  }, [allowed, id, asked]);

  // The group's name, when it is one this caller may pick (ADR-0143); the id otherwise.
  const groups = useAudienceGroups(null);
  const groupName = (lottery && Array.isArray(groups) ? groups.find((g) => g.id === lottery.userGroupId)?.name : undefined) ?? null;

  if (sessionLoading) return null;
  if (!allowed) {
    return (
      <div className="mx-auto w-full max-w-7xl p-4 md:p-8">
        <Alert tone="error">{t("common", K.notAllowed)}</Alert>
      </div>
    );
  }

  const time = (instant: string | null) => formatInstant(instant, lang) ?? "—";

  async function act(kind: Exclude<Confirming, null>) {
    if (!lottery) return;
    setBusy(true);
    setFailure(null);
    try {
      if (kind === "remove") {
        await lotteryAdminApi.remove(lottery.id);
        router.push(PANEL_LOTTERIES_MANAGE);
        return;
      }
      const next = kind === "publish" ? await lotteryAdminApi.publish(lottery.id) : await lotteryAdminApi.cancel(lottery.id, reason.trim());
      setLottery(next);
      setConfirming(null);
      setReason("");
      setNotice(t("common", kind === "publish" ? K.acts.published : K.acts.cancelledDone));
    } catch (e) {
      setFailure(message(e));
    } finally {
      setBusy(false);
    }
  }

  const back = (
    <Link href={PANEL_LOTTERIES_MANAGE} className={buttonClass({ variant: "quiet", size: "sm" })}>
      <ArrowLeft size={12} aria-hidden className="rtl:rotate-180" />
      {t("common", K.back)}
    </Link>
  );

  if (error) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-4 p-4 md:p-8">
        {back}
        <div className="flex flex-wrap items-center gap-3">
          <Alert tone="error">{message(error)}</Alert>
          <Button variant="quiet" size="sm" onClick={reload} icon={<RotateCw size={12} aria-hidden />}>
            {t("common", K.retry)}
          </Button>
        </div>
      </div>
    );
  }
  if (!lottery) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-4 p-4 md:p-8">
        {back}
        <TableSkeleton rows={4} columns={3} withPagination={false} />
      </div>
    );
  }

  const acts = actionsFor(lottery.status);
  const prizes = [...lottery.prizes].sort((a, b) => a.rank - b.rank);

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-4 md:p-8">
      <PageHeader
        tail={lottery.title}
        title={
          <>
            <span dir="auto">{lottery.title}</span>
            <StatusPill lottery={lottery} />
          </>
        }
        subtitle={lottery.description && <span dir="auto">{lottery.description}</span>}
      />

      {notice && <p className="text-xs font-bold text-primary">{notice}</p>}

      {editing && (
        <LotteryWizard
          from={lottery}
          onClose={() => setEditing(false)}
          onSaved={(l) => {
            setEditing(false);
            setLottery(l);
          }}
        />
      )}
      <section className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-4 text-sm">
        <ul className="space-y-1 text-xs text-text-secondary">
          <li>{t("common", K.detail.group, { name: groupName ?? lottery.userGroupId })}</li>
          <li>{t("common", K.mode[lottery.entryMode])}</li>
          <li>{t("common", K.detail.closesAt, { time: time(lottery.closesAt) })}</li>
          {lottery.publishedAt && <li>{t("common", K.detail.publishedAt, { time: time(lottery.publishedAt) })}</li>}
          {lottery.requiresPhoneVerified && <li>{t("common", K.detail.phoneRequired)}</li>}
          <li>{t("common", K.detail.minAge, { n: lottery.requiresMinAccountAgeHours })}</li>
          <li>{t("common", K.detail.reserves, { n: lottery.reservesCount })}</li>
        </ul>
        {lottery.status === "cancelled" && (
          <p className="text-xs font-bold text-text-primary" dir="auto">
            {t("common", K.detail.cancelled, { time: time(lottery.cancelledAt), reason: lottery.cancelReason ?? "" })}
          </p>
        )}
        <ol className="space-y-1 text-xs text-text-primary">
          {prizes.map((p) => (
            <li key={p.id} dir="auto">
              {t("common", K.detail.prize, { rank: p.rank, label: p.label, n: p.winnersCount })}
            </li>
          ))}
        </ol>

        {(acts.edit || acts.publish || acts.remove || acts.cancel) && (
          <div className="flex flex-wrap gap-2 border-t border-card-border pt-3">
            {acts.edit && (
              <Button variant="quiet" size="sm" onClick={() => setEditing(true)} disabled={busy}>
                {t("common", K.acts.edit)}
              </Button>
            )}
            {acts.publish && (
              <Button variant="primary" size="sm" onClick={() => setConfirming("publish")} disabled={busy}>
                {t("common", K.acts.publish)}
              </Button>
            )}
            {acts.remove && (
              <Button variant="quiet" size="sm" onClick={() => setConfirming("remove")} disabled={busy}>
                {t("common", K.acts.delete)}
              </Button>
            )}
            {acts.cancel && (
              <Button variant="quiet" size="sm" onClick={() => setConfirming("cancel")} disabled={busy}>
                {t("common", K.acts.cancel)}
              </Button>
            )}
          </div>
        )}

        {confirming && (
          <div className="space-y-3 rounded-xl bg-bg-inner p-3">
            {confirming === "cancel" ? (
              <Field label={t("common", K.acts.cancelReason)}>
                <Textarea className="min-h-16" dir="auto" maxLength={REASON_MAX} value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
            ) : (
              <p className="text-xs text-text-primary">{t("common", confirming === "publish" ? K.acts.publishConfirm : K.acts.deleteConfirm)}</p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="quiet"
                size="sm"
                onClick={() => {
                  setConfirming(null);
                  setFailure(null);
                }}
                disabled={busy}
              >
                {t("common", K.acts.keep)}
              </Button>
              <Button variant="primary" size="sm" onClick={() => act(confirming)} disabled={busy || (confirming === "cancel" && !reason.trim())}>
                {t("common", busy ? K.acts.working : confirming === "cancel" ? K.acts.cancelConfirm : K.acts.confirm)}
              </Button>
            </div>
          </div>
        )}
        {failure && <Alert tone="error">{failure}</Alert>}
      </section>

      {lottery.status !== "cancelled" && <EligibilityCard key={lottery.status} lotteryId={lottery.id} status={lottery.status} />}
      {lottery.status === "drawn" ? <WinnersCard lotteryId={lottery.id} /> : lottery.status === "frozen" && <p className="text-xs text-text-secondary">{t("common", K.winners.notYet)}</p>}
    </div>
  );
}

/** Who enters: billing's estimate until the freeze, the frozen list after. Asked for again on demand. */
function EligibilityCard({ lotteryId, status }: { lotteryId: string; status: AdminLottery["status"] }) {
  const { lang, t } = useLocale();
  const message = useLotteryMessage();
  const [data, setData] = useState<LotteryEligibility | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);

  useEffect(() => {
    let alive = true;
    lotteryAdminApi.eligibility(lotteryId).then(
      (d) => alive && setData(d),
      (e) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [lotteryId, asked]);

  const excluded = data ? Object.entries(data.excluded).filter(([, n]) => n > 0) : [];
  return (
    <section className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-bold text-text-primary">{t("common", K.eligibility.title)}</h2>
        {!data?.final && (
          <Button
            variant="quiet"
            size="sm"
            onClick={() => {
              setData(null);
              setError(null);
              setAsked((n) => n + 1);
            }}
            icon={<RotateCw size={12} aria-hidden />}
          >
            {t("common", K.eligibility.refresh)}
          </Button>
        )}
      </div>
      {error ? (
        <Alert tone="error">{message(error)}</Alert>
      ) : !data ? (
        <p className="text-xs text-text-secondary">{t("common", K.eligibility.loading)}</p>
      ) : (
        <div className="space-y-2 text-xs">
          <p className="text-text-secondary">{t("common", data.final ? K.eligibility.final : K.eligibility.estimate, { time: formatInstant(data.asOf, lang) ?? "—" })}</p>
          <ul className="space-y-1 text-text-primary">
            {data.final ? (
              <li className="font-bold">{t("common", K.eligibility.tickets, { n: data.eligible, total: data.candidates })}</li>
            ) : (
              <>
                <li>{t("common", K.eligibility.members, { n: data.members ?? 0 })}</li>
                <li>{t("common", K.eligibility.eligibleMembers, { n: data.eligibleMembers ?? 0 })}</li>
                {status !== "draft" && data.candidates !== data.members && <li>{t("common", K.eligibility.joined, { n: data.candidates })}</li>}
                <li className="font-bold">{t("common", K.eligibility.wouldGet, { n: data.eligible })}</li>
              </>
            )}
            {data.skippedResellerCount > 0 && <li className="text-text-secondary">{t("common", K.eligibility.skipped, { n: data.skippedResellerCount })}</li>}
          </ul>
          {excluded.length > 0 && (
            <div>
              <p className="font-bold text-text-primary">{t("common", K.eligibility.excludedTitle)}</p>
              <ul className="text-text-secondary">
                {excluded.map(([r, n]) => {
                  const key = excludedCountKeyOf(r);
                  return <li key={r}>{key ? t("common", key, { n }) : `${r}: ${n}`}</li>;
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** Each place, who holds it and whether the prize reached them (F-707-m). Only once drawn. */
function WinnersCard({ lotteryId }: { lotteryId: string }) {
  const { lang, t } = useLocale();
  const message = useLotteryMessage();
  const [data, setData] = useState<LotteryWinners | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    lotteryAdminApi.winners(lotteryId).then(
      (d) => alive && setData(d),
      (e) => alive && setError(e),
    );
    return () => {
      alive = false;
    };
  }, [lotteryId]);

  return (
    <section className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-4">
      <h2 className="text-sm font-bold text-text-primary">{t("common", K.winners.title)}</h2>
      {error ? (
        <Alert tone="error">{message(error)}</Alert>
      ) : !data ? (
        <TableSkeleton rows={3} columns={4} withPagination={false} />
      ) : (
        <>
          <p className="text-xs text-text-secondary">
            {t("common", K.winners.drawnAt, { time: formatInstant(data.drawnAt, lang) ?? "—" })} ·{" "}
            {data.publishedAt ? t("common", K.winners.publishedAt, { time: formatInstant(data.publishedAt, lang) ?? "—" }) : t("common", K.winners.notPublished)}
          </p>
          {data.places.length === 0 ? (
            <p className="text-xs text-text-secondary">{t("common", K.winners.noPlaces)}</p>
          ) : (
            <ul className="divide-y divide-card-border text-xs">
              {data.places.map((p) => {
                const passedOn = p.passedOnReason ? passedOnKeyOf(p.passedOnReason) : null;
                return (
                  <li key={p.position} className="flex flex-col gap-1 py-2 md:flex-row md:items-center md:justify-between">
                    <div className="space-y-0.5">
                      <p className="font-bold text-text-primary">
                        {t("common", K.winners.place, { n: p.position })} · {t("common", K.winners.ticket, { n: p.ticketNumber })} ·{" "}
                        <span dir="auto">{p.prize ? `${p.prize.rank}. ${p.prize.label}` : t("common", K.winners.reserve)}</span>
                      </p>
                      <p className="text-text-secondary" dir="auto">
                        {p.user ? `${p.user.fullName}${p.user.username ? ` (@${p.user.username})` : ""}` : t("common", K.winners.accountGone)}
                        {p.replacesPosition !== null && <> · {t("common", K.winners.replaces, { n: p.replacesPosition })}</>}
                      </p>
                    </div>
                    {p.prize && (
                      <p className="text-text-secondary">
                        <span className="font-bold text-text-primary">{t("common", K.winners.delivery[p.delivery])}</span>
                        {p.deliveredAt && <> · {t("common", K.winners.deliveredAt, { time: formatInstant(p.deliveredAt, lang) ?? "—" })}</>}
                        {p.delivery === "passed_on" && <> · {passedOn ? t("common", passedOn) : p.passedOnReason}</>}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
