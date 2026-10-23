"use client";

import { useState } from "react";
import { KeyRound, PlugZap, Plus, RotateCw } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import type { MigrationRun, MigrationRunsApi, ResellerRouter } from "@/lib/billing-api";
import { FAULT_KEYS, REVIEW_KEYS, SYSTEMS_KEYS } from "../../../../systems/_lib/systems";
import { MIGRATION_KEYS as K } from "../../../_lib/migration";
import { ROUTER_TONE, isPickable, type InPlaceFamily } from "../../../_lib/migration-router";
import { useMigrationMessage } from "../_hooks/useMigrationLive";
import { useResellerRouters } from "../_hooks/useResellerRouters";
import { RouterForm } from "./RouterForm";
import { TableSkeleton } from "../../../../_components/kit/TableSkeleton";
import { Alert, Button, StatusPill } from "../../../../_components/kit";

/** The one form open under the list: a new router, or one router's login typed again. */
type Open = { kind: "add" } | { kind: "login"; router: ResellerRouter } | null;

/**
 * The in-place start (F-1601-c, entitlement `contract.import-in-place.md`):
 * a MikroTik User Manager is read from one of the reseller's own registered
 * routers, never through an address and login typed for the run. Each router
 * shows its connection test; one accepted is read, which creates the run
 * naming it and asks its preview. A router is registered here when there is
 * none (F-1601-g), and a login the router refused is entered again.
 */
export function RouterPicker({
  api,
  tenantId,
  family,
  onDone,
  onCancel,
}: {
  api: MigrationRunsApi;
  tenantId: string;
  family: InPlaceFamily;
  onDone: (run: MigrationRun) => void;
  onCancel?: () => void;
}) {
  const { t } = useLocale();
  const message = useMigrationMessage();
  const { routers, error: listError, reread } = useResellerRouters(api, tenantId);
  const [open, setOpen] = useState<Open>(null);
  // A run created before its preview failed: a retry previews it, never a second run.
  const [created, setCreated] = useState<MigrationRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function read(router: ResellerRouter) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      let run = created?.sourcePanelId === router.id ? created : null;
      if (!run) {
        run = await api.create({ family, panelId: router.id });
        setCreated(run);
      }
      onDone(await api.preview(run.id));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const written = () => {
    setOpen(null);
    reread();
  };
  // With no router yet, the register form is the step itself.
  const adding = open?.kind === "add" || (routers !== null && routers.length === 0);
  const failure = error ?? listError;

  return (
    <div className="space-y-4">
      <p className="text-sm text-text-secondary">{t("common", K.router.intro)}</p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-text-primary">{t("common", K.router.listTitle)}</h3>
        <div className="flex flex-wrap gap-2">
          {/* The owner acting in a reseller's workspace does not hear the reseller's channel (`routersChannelOf`). */}
          <Button size="sm" variant="quiet" onClick={reread} icon={<RotateCw size={12} aria-hidden />}>
            {t("common", K.refresh)}
          </Button>
          {!adding && (
            <Button size="sm" variant="secondary" onClick={() => setOpen({ kind: "add" })} icon={<Plus size={12} aria-hidden />}>
              {t("common", K.router.add)}
            </Button>
          )}
        </div>
      </div>
      {routers === null && listError === null && <TableSkeleton rows={2} columns={2} />}
      {routers !== null && routers.length === 0 && <p className="text-sm text-text-secondary">{t("common", K.router.empty)}</p>}
      {routers !== null && routers.length > 0 && (
        <ul className="divide-y divide-card-border rounded-xl border border-card-border">
          {routers.map((r) => (
            <RouterRow key={r.id} router={r} busy={busy} onRead={() => void read(r)} onLogin={() => setOpen({ kind: "login", router: r })} />
          ))}
        </ul>
      )}
      {open?.kind === "login" && <RouterForm key={open.router.id} api={api} family={family} router={open.router} onDone={written} onCancel={() => setOpen(null)} />}
      {adding && <RouterForm api={api} family={family} onDone={written} onCancel={() => (routers?.length ? setOpen(null) : onCancel?.())} />}
      {failure !== null && <Alert tone="error">{message(failure)}</Alert>}
      {onCancel && !adding && (
        <Button variant="quiet" size="sm" disabled={busy} onClick={onCancel}>
          {t("common", K.back)}
        </Button>
      )}
    </div>
  );
}

/** One router: its name and address, its test, and what can be done with it now. */
function RouterRow({ router, busy, onRead, onLogin }: { router: ResellerRouter; busy: boolean; onRead: () => void; onLogin: () => void }) {
  const { t } = useLocale();
  const pickable = isPickable(router);
  // A test with no answer yet: the fault says why, and a refused login is typed again.
  const waiting = router.reviewState === "pending";
  return (
    <li className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-center gap-2 text-sm font-bold text-text-primary">
          <span dir="auto">{router.name}</span>
          <StatusPill tone={ROUTER_TONE[router.reviewState]}>{t("common", REVIEW_KEYS[router.reviewState])}</StatusPill>
        </p>
        {router.address && (
          <p className="truncate text-xs text-text-secondary" dir="ltr">
            {router.address}
          </p>
        )}
        {waiting && router.fault && (
          <p className="text-xs text-text-secondary">
            {t("common", SYSTEMS_KEYS.review.faultHint)} {t("common", FAULT_KEYS[router.fault])}
          </p>
        )}
        {!pickable && !router.fault && <p className="text-xs text-text-secondary">{t("common", waiting ? K.router.notReady : SYSTEMS_KEYS.review.refusedHint)}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        {pickable && (
          <Button size="sm" disabled={busy} onClick={onRead} icon={<PlugZap size={14} aria-hidden />}>
            {t("common", busy ? K.connecting : K.router.read)}
          </Button>
        )}
        {waiting && router.fault && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={onLogin} icon={<KeyRound size={14} aria-hidden />}>
            {t("common", K.router.loginAgain)}
          </Button>
        )}
      </div>
    </li>
  );
}
