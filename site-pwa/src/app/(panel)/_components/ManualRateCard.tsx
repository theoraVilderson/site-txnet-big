"use client";

import { useEffect, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { currencyApi, type CurrencyPinForm, type CurrencyRate } from "@/lib/currency-api";
import { formatInstant } from "../_lib/datetime";
import { TableSkeleton } from "./kit/TableSkeleton";
import { Alert, Button, Card, CardHeader, Checkbox, Field, Input, NativeSelect, notify } from "./kit";

const K = FrontendI18nKeys.common.manualRate;

/** The pin routes' refusals (`currency/contract.md` "HTTP API"), each with its own sentence. */
type Refusal = keyof typeof K.refusals;
const refusalOf = (e: unknown): Refusal | null => {
  const reason = (e as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && reason in K.refusals ? (reason as Refusal) : null;
};

const RATE = /^\d{1,10}(\.\d{1,18})?$/;
const DEFAULT_HOURS = 24;

/**
 * A manual rate for any currency (F-116-l, `currency/contract.md`, ADR-0101).
 * The pin routes are the caller's session's: on the platform's domain its staff
 * pin for everyone, on a reseller's domain its staff pin for that reseller's
 * books only — so this card lives on `/settings`, never in a workspace whose
 * owner's session is the platform's (invariant 21).
 *
 *  - **the worker's reading is a suggestion** (D-53): the rate box starts
 *    empty and a reading fills it only when clicked;
 *  - **a pin is never one click**: it is sent after a sentence naming the
 *    rate and how long it holds — by default, until someone ends it (F-116-n);
 *  - **what is live is the answer's**: after a pin or an end the form is read
 *    again, never patched from what was sent.
 */
export function ManualRateCard({ scope }: { scope: "platform" | "reseller" }) {
  const { t, lang } = useLocale();
  const errorMessage = useApiErrorMessage();
  const message = (e: unknown) => {
    const refusal = refusalOf(e);
    return refusal ? t("common", K.refusals[refusal]) : errorMessage(e);
  };

  const [currencies, setCurrencies] = useState<CurrencyRate[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const [code, setCode] = useState("");
  /** The form as last read, and for which code and read — anything else is still loading. */
  const [read, setRead] = useState<{ key: string; form: CurrencyPinForm | null; error: unknown }>({
    key: "",
    form: null,
    error: null,
  });
  const [rate, setRate] = useState("");
  const [reason, setReason] = useState("");
  /** No end is the default (user, F-116-n): the rate holds until someone ends it. */
  const [forever, setForever] = useState(true);
  const [hours, setHours] = useState(String(DEFAULT_HOURS));
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    currencyApi
      .rates()
      .then((all) => {
        if (!alive) return;
        const pinnable = all.filter((c) => !c.isBase);
        setCurrencies(pinnable);
        setCode((now) => (now && pinnable.some((c) => c.code === now) ? now : (pinnable[0]?.code ?? "")));
      })
      .catch((e) => alive && setLoadError(e));
    return () => {
      alive = false;
    };
  }, [asked]);

  useEffect(() => {
    if (!code) return;
    let alive = true;
    const key = `${code}#${asked}`;
    currencyApi
      .pinForm(code)
      .then((form) => alive && setRead({ key, form, error: null }))
      .catch((error) => alive && setRead({ key, form: null, error: error ?? "error" }));
    return () => {
      alive = false;
    };
  }, [code, asked]);

  const reread = () => setAsked((n) => n + 1);
  const fresh = read.key === `${code}#${asked}`;
  const form = fresh ? read.form : null;
  const formError = fresh ? read.error : null;
  const hoursN = Number(hours);
  const hoursOk = forever || (Number.isInteger(hoursN) && hoursN >= 1 && hoursN <= 720);
  const valid = RATE.test(rate) && Number(rate) > 0 && reason.trim().length >= 3 && hoursOk;
  /** A pin's line: until its end, or "until ended" for one with none. */
  const pinLine = (p: { rate: string; expiresAt: string | null }) =>
    p.expiresAt
      ? t("common", K.pinLine, { code, rate: p.rate, until: formatInstant(p.expiresAt, lang) ?? "" })
      : t("common", K.pinLineForever, { code, rate: p.rate });

  const pick = (next: string) => {
    setCode(next);
    setRate("");
    setFailure(null);
    setConfirming(false);
  };

  const submit = async () => {
    setBusy(true);
    setFailure(null);
    try {
      const pin = await currencyApi.pin({ code, rate, reason: reason.trim(), hours: forever ? null : hoursN });
      notify.success(t("common", K.pinned, { code: pin.code, rate: pin.rate }));
      setRate("");
      setReason("");
      reread();
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const end = async (id: string) => {
    setBusy(true);
    setFailure(null);
    try {
      await currencyApi.endPin(id);
      notify.success(t("common", K.ended, { code }));
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(false);
      reread();
    }
  };

  const reading = form?.lastDownload;
  const suggestion = reading?.rate && reading.rate !== form?.lastAccepted?.rate ? reading.rate : null;

  return (
    <Card padding="lg" className="mt-6">
      <CardHeader title={t("common", K.title)} subtitle={t("common", scope === "platform" ? K.hintPlatform : K.hint)} />

      {loadError !== null ? (
        <div className="space-y-3">
          <Alert tone="error">{message(loadError)}</Alert>
          <Button
            variant="quiet"
            size="sm"
            onClick={() => {
              setLoadError(null);
              reread();
            }}
          >
            {t("common", K.reload)}
          </Button>
        </div>
      ) : currencies === null ? (
        <TableSkeleton rows={1} columns={2} />
      ) : currencies.length === 0 ? (
        <p className="text-sm text-text-secondary">{t("common", K.none)}</p>
      ) : (
        <div className="space-y-4">
          <Field label={t("common", K.currency)}>
            <NativeSelect value={code} disabled={busy || confirming} onChange={(e) => pick(e.target.value)}>
              {currencies.map((c) => (
                <option key={c.code} value={c.code}>
                  {t("common", c.pinned ? K.choicePinned : K.choice, { name: c.name, code: c.code })}
                </option>
              ))}
            </NativeSelect>
          </Field>

          {formError ? (
            <Alert tone="error">{message(formError)}</Alert>
          ) : form === null ? (
            <TableSkeleton rows={2} columns={2} />
          ) : (
            <>
              <dl className="space-y-1 text-sm text-text-primary">
                <div>
                  <dt className="inline text-text-secondary">{t("common", K.lastAccepted)} </dt>
                  <dd className="inline">
                    {form.lastAccepted ? t("common", K.rateLine, { code, rate: form.lastAccepted.rate }) : t("common", K.noRate)}
                  </dd>
                </div>
                {form.platformPin && (
                  <div>
                    <dt className="inline text-text-secondary">{t("common", K.platformPin)} </dt>
                    <dd className="inline">{pinLine(form.platformPin)}</dd>
                  </div>
                )}
              </dl>

              {form.current && (
                <div className="space-y-2 rounded-2xl border border-primary/20 bg-leaf-bg p-4">
                  <p className="text-sm font-bold text-text-primary">{pinLine(form.current)}</p>
                  <p className="text-sm text-text-secondary">{form.current.reason}</p>
                  <Button variant="quiet" size="sm" disabled={busy} onClick={() => end(form.current!.id)}>
                    {t("common", K.end)}
                  </Button>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("common", K.rate, { code })} className="sm:col-span-2">
                  <Input
                    inputMode="decimal"
                    dir="ltr"
                    value={rate}
                    disabled={busy || confirming}
                    onChange={(e) => setRate(e.target.value.trim())}
                  />
                </Field>
                {suggestion && (
                  <div className="sm:col-span-2">
                    <Button
                      variant="quiet"
                      size="sm"
                      disabled={busy || confirming}
                      onClick={() => setRate(suggestion)}
                    >
                      {t("common", K.useReading, { rate: suggestion })}
                    </Button>
                  </div>
                )}
                <Field label={t("common", K.reason)}>
                  <Input
                    value={reason}
                    maxLength={500}
                    disabled={busy || confirming}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </Field>
                <div className="space-y-2">
                  <Checkbox checked={forever} disabled={busy || confirming} onChange={setForever} label={t("common", K.noEnd)} />
                  {!forever && (
                    <Field label={t("common", K.hours)}>
                      <Input
                        inputMode="numeric"
                        dir="ltr"
                        value={hours}
                        disabled={busy || confirming}
                        onChange={(e) => setHours(e.target.value.trim())}
                      />
                    </Field>
                  )}
                </div>
              </div>

              <Button
                variant="primary"
                disabled={busy || confirming || !valid}
                onClick={() => setConfirming(true)}
              >
                {t("common", K.pin)}
              </Button>

              {confirming && (
                <div className="space-y-3 rounded-2xl border border-gold/20 bg-gold-bg p-4">
                  <h3 className="flex items-center gap-2 text-sm font-bold text-text-primary">
                    <AlertTriangle size={16} className="shrink-0 text-gold" aria-hidden />
                    {forever
                      ? t("common", K.confirm.titleForever, { code, rate })
                      : t("common", K.confirm.title, { code, rate, hours: hoursN })}
                  </h3>
                  <p className="text-sm text-text-primary">
                    {t("common", scope === "platform" ? K.confirm.bodyPlatform : K.confirm.body)}
                  </p>
                  <div className="flex gap-2">
                    <Button variant="primary" size="sm" loading={busy} onClick={submit}>
                      {t("common", K.confirm.yes)}
                    </Button>
                    <Button variant="quiet" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
                      {t("common", K.confirm.no)}
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}

          {failure !== null && <Alert tone="error">{message(failure)}</Alert>}
        </div>
      )}
    </Card>
  );
}
