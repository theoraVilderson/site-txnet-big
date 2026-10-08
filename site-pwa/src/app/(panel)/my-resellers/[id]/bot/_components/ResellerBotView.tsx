"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Bot, CheckCircle2, Clock, Loader2, PauseCircle, RefreshCw, Trash2, type LucideIcon } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { authApi, resellerBotsApi, type BotPlatformName, type ResellerBot } from "@/lib/auth-api";
import { Select } from "../../../../_components/kit/Select";
import { TableSkeleton } from "../../../../_components/kit/TableSkeleton";
import { Badge } from "../../../../financial/_components/Badge";
import { Field } from "../../../../catalog/_components/catalog-ui";
import {
  BOT_HINT_KEYS,
  BOT_KEYS as K,
  BOT_PLATFORMS,
  BOT_ROLE_KEYS,
  BOT_STATUS_HINT_KEYS,
  BOT_STATUS_KEYS,
  PLATFORM_KEYS,
  botRefusalKey,
  botToken,
  connectBody,
  isPrimaryTaken,
} from "../../../_lib/bots";
import { Alert, Button, Input, PageHeader, useConfirm } from "../../../../_components/kit";

/** The refusal's own sentence, else the generic answer for that error. */
function useMessage() {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  return (e: unknown) => {
    const key = botRefusalKey(e);
    return key ? t("common", key) : errorMessage(e);
  };
}

const STATUS_TONE: Record<ResellerBot["status"], { icon: LucideIcon; className: string }> = {
  pending: { icon: Clock, className: "border-gold/20 bg-gold-bg text-gold" },
  active: { icon: CheckCircle2, className: "border-primary/20 bg-leaf-bg text-primary" },
  disabled: { icon: PauseCircle, className: "border-card-border bg-bg-inner text-text-secondary" },
  error: { icon: AlertCircle, className: "border-error-border bg-error-bg text-error" },
};

/**
 * A reseller's bot (F-066-w6, `panel-web/contract.resellers.md` "Its bot").
 * By the reseller the path names, never the session's tenant (ADR-0064): its
 * owner signs in to the platform owner's tenant, so the ambient surface would
 * configure the platform's own bot.
 *
 *  - **no permission is judged here.** auth-service admits the owner, a staff
 *    seat with `tenant.manage` or platform support; any other visitor gets its
 *    sentence;
 *  - **a connect that the messenger did not register is still a connect.** The
 *    answer's `registered: false` is said out loud and nothing is retried: the
 *    row is `pending` and `bot-service` registers it on its next boot;
 *  - **one bot per messenger** (`primary`, C-05). A second is `primary_exists`,
 *    so the form says so before the call;
 *  - **nothing here carries a credential.** No token is ever read back, and a
 *    bot is retired by its `@handle` — the webhook path is a credential
 *    (F-323, ADR-0009) and is not on the wire.
 */
export function ResellerBotView({ id }: { id: string }) {
  const { t } = useLocale();
  const message = useMessage();

  const [bots, setBots] = useState<ResellerBot[] | null>(null);
  const [slug, setSlug] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const retry = () => {
    setLoadError(null);
    setAsked((n) => n + 1);
  };

  useEffect(() => {
    let alive = true;
    resellerBotsApi
      .list(id)
      .then((list) => alive && setBots(list))
      .catch((e) => alive && setLoadError(e));
    return () => {
      alive = false;
    };
  }, [id, asked]);

  // The name for the title, when the visitor owns it; staff see the plain title.
  useEffect(() => {
    let alive = true;
    authApi
      .ownedResellers()
      .then((r) => alive && setSlug(r.resellers.find((x) => x.id === id)?.slug ?? null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id]);

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 p-4 md:p-8">
      <PageHeader
        title={slug ? t("common", K.title, { slug }) : t("common", K.titlePlain)}
        subtitle={t("common", K.subtitle)}
        actions={
          <>
            <Button variant="quiet" size="sm" onClick={retry} icon={<RefreshCw size={12} aria-hidden />}>
            {t("common", K.refresh)}
          </Button>
          </>
        }
      />

      {loadError !== null ? (
        <div className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-6">
          <Alert tone="error">{message(loadError)}</Alert>
          <Button variant="primary" size="sm" onClick={retry}>
            {t("common", K.reload)}
          </Button>
        </div>
      ) : bots === null ? (
        <TableSkeleton rows={2} columns={2} />
      ) : (
        <>
          <ConnectBot id={id} bots={bots} onConnected={(bot) => setBots((list) => [bot, ...(list ?? [])])} />
          <section className="space-y-3">
            <h2 className="text-base font-bold text-text-primary">{t("common", K.connected)}</h2>
            {bots.length === 0 ? (
              <p className="rounded-2xl border border-card-border bg-card-bg p-6 text-sm text-text-secondary">
                {t("common", K.empty)}
              </p>
            ) : (
              bots.map((bot) => (
                <BotCard
                  key={bot.id}
                  tenantId={id}
                  bot={bot}
                  onRetired={() => setBots((list) => (list ?? []).filter((b) => b.id !== bot.id))}
                />
              ))
            )}
          </section>
        </>
      )}
    </div>
  );
}

function ConnectBot({ id, bots, onConnected }: { id: string; bots: ResellerBot[]; onConnected: (bot: ResellerBot) => void }) {
  const { t } = useLocale();
  const message = useMessage();
  const [platform, setPlatform] = useState<BotPlatformName>(BOT_PLATFORMS[0]);
  const [raw, setRaw] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [failure, setFailure] = useState<unknown>(null);
  const [pendingWebhook, setPendingWebhook] = useState(false);
  const [busy, setBusy] = useState(false);
  const taken = isPrimaryTaken(bots, platform);

  async function submit() {
    const token = botToken(raw);
    setError(token ? undefined : K.errors.token);
    if (!token) return;
    setBusy(true);
    setFailure(null);
    setPendingWebhook(false);
    try {
      const { bot, registered } = await resellerBotsApi.connect(id, connectBody(platform, token));
      onConnected(bot);
      setPendingWebhook(!registered);
      setRaw("");
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="space-y-4 rounded-2xl border border-card-border bg-card-bg p-6"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2 className="text-base font-bold text-text-primary">{t("common", K.add.title)}</h2>
      <div className="grid gap-4 md:grid-cols-[12rem_1fr]">
        <Field label={t("common", K.add.platform)}>
          <Select
            value={platform}
            onChange={(v) => setPlatform(v as BotPlatformName)}
            options={BOT_PLATFORMS.map((p) => ({ value: p, label: t("common", PLATFORM_KEYS[p]) }))}
          />
        </Field>
        <Field label={t("common", K.add.token)} error={error} hint={t("common", K.add.tokenHint)}>
          <Input
            dir="ltr"
            autoComplete="off"
            placeholder="123456789:AA..."
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
        </Field>
      </div>
      {/* Where the token comes from: a reseller who has never made a bot needs this before the field. */}
      <p className="text-xs text-text-secondary">{t("common", BOT_HINT_KEYS[platform])}</p>
      {taken && <Alert tone="error">{t("common", K.add.primaryTaken)}</Alert>}
      {failure !== null && <Alert tone="error">{message(failure)}</Alert>}
      {pendingWebhook && (
        <p className="rounded-xl border border-gold/20 bg-gold-bg p-3 text-xs text-gold">{t("common", K.notRegistered)}</p>
      )}
      <Button variant="primary" size="sm" type="submit" disabled={taken} loading={busy}>
        {t("common", busy ? K.add.connecting : K.add.submit)}
      </Button>
    </form>
  );
}

function BotCard({ tenantId, bot, onRetired }: { tenantId: string; bot: ResellerBot; onRetired: () => void }) {
  const { t } = useLocale();
  const confirm = useConfirm();
  const message = useMessage();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [orphanWebhook, setOrphanWebhook] = useState(false);
  const tone = STATUS_TONE[bot.status];

  async function retire() {
    // Asked once: the token is revoked and the reseller's customers stop
    // reaching the bot, and nothing here undoes that.
    if (!(await confirm({ title: t("common", K.removeConfirm), confirmLabel: t("common", K.remove), tone: "danger" }))) return;
    setBusy(true);
    setFailure(null);
    try {
      const { webhookRemoved } = await resellerBotsApi.retire(tenantId, bot.platform, bot.botUsername);
      if (webhookRemoved) onRetired();
      else setOrphanWebhook(true);
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Bot size={16} className="text-text-secondary" aria-hidden />
          <span dir="ltr" className="text-base font-bold text-text-primary">
            @{bot.botUsername}
          </span>
          <span className="text-xs text-text-secondary">{t("common", PLATFORM_KEYS[bot.platform])}</span>
          <Badge {...tone} label={t("common", BOT_STATUS_KEYS[bot.status])} />
          <span className="text-xs text-text-secondary">{t("common", BOT_ROLE_KEYS[bot.role])}</span>
        </div>
        <Button
          variant="quiet"
          size="sm"
          onClick={() => void retire()}
          disabled={busy}
          icon={busy ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <Trash2 size={12} aria-hidden />}
          className="text-error hover:text-error hover:bg-error-bg"
        >
          {t("common", busy ? K.removing : K.remove)}
        </Button>
      </div>
      <p className="text-xs text-text-secondary">{t("common", BOT_STATUS_HINT_KEYS[bot.status])}</p>
      {orphanWebhook && (
        <>
          {/* The token is already revoked; only the messenger was not told, so
              the row is gone from the service and the card says why it stays. */}
          <Alert tone="error">{t("common", K.webhookNotRemoved)}</Alert>
          <Button variant="quiet" size="sm" onClick={onRetired}>
            {t("common", K.removed)}
          </Button>
        </>
      )}
      {failure !== null && <Alert tone="error">{message(failure)}</Alert>}
    </section>
  );
}
