"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, RotateCw, SlidersHorizontal, Trash2 } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { supportSettingsApi, type AdminCategory, type CategoryList, type SlaTarget } from "@/lib/support-api";
import { DataTable } from "../../_components/kit/DataTable";
import { TableSkeleton } from "../../_components/kit/TableSkeleton";
import { AGENT_KEYS, PRIORITIES, PRIORITY_KEYS, categoryTexts, fromHhmm, slaFormErrors, toHhmm } from "../_lib/support-agent";
import { PageHeader } from "../../_components/kit/PageHeader";
import { Alert, Button, Checkbox, Field, IconButton, Input, Tabs } from "../../_components/kit";

const K = AGENT_KEYS.settings;
type Tab = "hours" | "sla" | "categories";
const TABS: readonly Tab[] = ["hours", "sla", "categories"];
/** Weekday 0 = Sunday, as support stores it; shown from Saturday, the Iranian week's first day. */
const WEEK: readonly { day: number; key: string }[] = [
  { day: 6, key: K.hours.weekday.sat },
  { day: 0, key: K.hours.weekday.sun },
  { day: 1, key: K.hours.weekday.mon },
  { day: 2, key: K.hours.weekday.tue },
  { day: 3, key: K.hours.weekday.wed },
  { day: 4, key: K.hours.weekday.thu },
  { day: 5, key: K.hours.weekday.fri },
];
/** Prisma's `Language`: the languages a category can be named in. */
const CATEGORY_LANGS = ["fa", "en"] as const;

/**
 * A tenant admin's support settings (F-033-p) over `/api/support/settings/*`:
 * working hours (F-033-g), SLA targets (F-033-h) and categories (F-033-e).
 * `support.manage`; support validates every save and its refusal is shown as
 * it came.
 */
export function SupportSettingsView() {
  const { t } = useLocale();
  const [tab, setTab] = useState<Tab>("hours");
  return (
    <div className="mx-auto w-full max-w-4xl space-y-5 p-4 md:p-8">
      <PageHeader
        icon={SlidersHorizontal}
        title={t("common", K.title)}
        subtitle={t("common", K.subtitle)}
      />
      <Tabs<Tab> ariaLabel={t("common", K.title)} variant="pills" value={tab} onChange={setTab} tabs={TABS.map((v) => ({ value: v, label: t("common", K.tabs[v]) }))} />
      {tab === "hours" && <HoursTab />}
      {tab === "sla" && <SlaTab />}
      {tab === "categories" && <CategoriesTab />}
    </div>
  );
}

/** Load once, retry on failure: the three tabs' shared shape. */
function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [asked, setAsked] = useState(0);
  const reload = useCallback(() => setAsked((n) => n + 1), []);
  useEffect(() => {
    let alive = true;
    load()
      .then((d) => {
        if (!alive) return;
        setData(d);
        setError(null);
      })
      .catch((e) => alive && setError(e));
    return () => {
      alive = false;
    };
    // `load` is a module-level call per tab; only a retry re-reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked]);
  return { data, setData, error, reload };
}

function Loading({ error, reload }: { error: unknown; reload: () => void }) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  return error ? (
    <div className="flex flex-wrap items-center gap-3">
      <Alert tone="error">{errorMessage(error)}</Alert>
      <Button variant="quiet" size="sm" onClick={reload} icon={<RotateCw size={12} aria-hidden />}>
        {t("common", AGENT_KEYS.retry)}
      </Button>
    </div>
  ) : (
    <TableSkeleton rows={4} columns={3} withPagination={false} />
  );
}

/** Save, then say "saved" or support's refusal. */
function useSave() {
  const errorMessage = useApiErrorMessage();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const { t } = useLocale();
  async function save(work: () => Promise<unknown>) {
    setBusy(true);
    setNote(null);
    try {
      await work();
      setNote({ ok: true, text: t("common", K.saved) });
    } catch (e) {
      setNote({ ok: false, text: errorMessage(e) });
    } finally {
      setBusy(false);
    }
  }
  return { busy, note, setNote, save };
}

function Note({ note }: { note: { ok: boolean; text: string } | null }) {
  if (!note) return null;
  return note.ok ? <p className="text-xs font-bold text-success">{note.text}</p> : <Alert tone="error">{note.text}</Alert>;
}

// ------------------------------------------------------------------ hours

type Period = { weekday: number; start: string; end: string };

function HoursTab() {
  const { t } = useLocale();
  // The form edits the loaded week itself: support answers minutes, the editor holds `HH:MM`.
  const { data, setData, error, reload } = useLoad(() =>
    supportSettingsApi.hours().then((h) => ({ zone: h.zone, periods: h.intervals.map((i): Period => ({ weekday: i.weekday, start: toHhmm(i.startMinute), end: toHhmm(i.endMinute) })) })),
  );
  const { busy, note, setNote, save } = useSave();

  if (!data) return <Loading error={error} reload={reload} />;
  const periods = data.periods;
  const setPeriods = (next: Period[]) => setData({ ...data, periods: next });

  const valid = (p: Period) => {
    const start = fromHhmm(p.start);
    const end = fromHhmm(p.end);
    return start !== null && end !== null && end > start;
  };
  const set = (index: number, change: Partial<Period>) => setPeriods(periods.map((p, i) => (i === index ? { ...p, ...change } : p)));

  return (
    <section className="space-y-4 rounded-2xl border border-card-border bg-card-bg p-4">
      <p className="text-xs text-text-secondary">{t("common", K.hours.zone, { zone: data.zone })}</p>
      {periods.length === 0 && <p className="text-xs text-text-secondary">{t("common", K.hours.alwaysOpen)}</p>}
      <ul className="space-y-3">
        {WEEK.map(({ day, key }) => (
          <li key={day} className="flex flex-wrap items-start gap-3">
            <span className="w-24 pt-2 text-sm font-bold text-text-primary">{t("common", key)}</span>
            <div className="flex-1 space-y-2">
              {periods.map((p, i) =>
                p.weekday !== day ? null : (
                  <div key={i} className="flex flex-wrap items-center gap-2 text-xs">
                    <Field label={t("common", K.hours.start)}>
                      <Input dir="ltr" className="w-24" value={p.start} placeholder="09:00" onChange={(e) => set(i, { start: e.target.value })} />
                    </Field>
                    <Field label={t("common", K.hours.end)}>
                      <Input dir="ltr" className="w-24" value={p.end} placeholder="17:00" onChange={(e) => set(i, { end: e.target.value })} />
                    </Field>
                    <IconButton size="sm" onClick={() => setPeriods(periods.filter((_, j) => j !== i))} aria-label={t("common", K.hours.remove)} icon={<Trash2 size={12} aria-hidden />} />
                    {!valid(p) && <span className="text-error">{t("common", K.hours.invalid)}</span>}
                  </div>
                ),
              )}
              <Button variant="quiet" size="sm" onClick={() => setPeriods([...periods, { weekday: day, start: "09:00", end: "17:00" }])} icon={<Plus size={12} aria-hidden />}>
                {t("common", K.hours.add)}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <Note note={note} />
      <Button
        variant="primary"
        size="sm"
        disabled={busy || !periods.every(valid)}
        onClick={() => {
          setNote(null);
          void save(() => supportSettingsApi.saveHours(periods));
        }}
      >
        {t("common", K.save)}
      </Button>
    </section>
  );
}

// -------------------------------------------------------------------- SLA

function SlaTab() {
  const { t } = useLocale();
  // Every priority, urgent first, even one support has no row for.
  const complete = (rows: SlaTarget[]) => PRIORITIES.map((p) => rows.find((d) => d.priority === p) ?? { priority: p, firstResponseMinutes: 0, resolutionMinutes: 0 });
  const { data: targets, setData: setTargets, error, reload } = useLoad(() => supportSettingsApi.sla().then(complete));
  const { busy, note, save } = useSave();

  if (!targets) return <Loading error={error} reload={reload} />;
  const invalid = new Set(slaFormErrors(targets));
  const set = (index: number, change: Partial<SlaTarget>) => setTargets(targets.map((x, i) => (i === index ? { ...x, ...change } : x)));

  return (
    <section className="space-y-4 rounded-2xl border border-card-border bg-card-bg p-4">
      <p className="text-xs text-text-secondary">{t("common", K.sla.hint)}</p>
      <DataTable
        label={t("common", K.tabs.sla)}
        compact
        bare
        rows={targets.map((x, i) => ({ ...x, i }))}
        rowKey={(x) => x.priority}
        columns={[
          { id: "priority", header: t("common", K.sla.priority), cell: (x) => t("common", PRIORITY_KEYS[x.priority]), className: "font-bold text-text-primary" },
          {
            id: "firstResponse",
            header: t("common", K.sla.firstResponse),
            cell: (x) => (
              <Input dir="ltr" type="number" min={1} aria-label={t("common", K.sla.firstResponse)} className="w-28" value={x.firstResponseMinutes} onChange={(e) => set(x.i, { firstResponseMinutes: Number(e.target.value) })} />
            ),
          },
          {
            id: "resolution",
            header: t("common", K.sla.resolution),
            cell: (x) => (
              <Input dir="ltr" type="number" min={1} aria-label={t("common", K.sla.resolution)} className="w-28" value={x.resolutionMinutes} onChange={(e) => set(x.i, { resolutionMinutes: Number(e.target.value) })} />
            ),
          },
          { id: "source", header: "", cell: (x) => x.source && t("common", K.sla[x.source]), className: "text-text-secondary" },
        ]}
      />
      {invalid.size > 0 && <Alert tone="error">{t("common", K.sla.invalid)}</Alert>}
      <Note note={note} />
      <Button
        variant="primary"
        size="sm"
        disabled={busy || invalid.size > 0}
        onClick={() =>
          void save(async () => {
            setTargets(complete(await supportSettingsApi.saveSla(targets)));
          })
        }
      >
        {t("common", K.save)}
      </Button>
    </section>
  );
}

// -------------------------------------------------------------- categories

type Draft = { id: string | null; key: string; sortOrder: number; isActive: boolean; names: Record<string, string> };

const draftOf = (c: AdminCategory): Draft => ({
  id: c.id,
  key: c.key,
  sortOrder: c.sortOrder,
  isActive: c.isActive,
  names: Object.fromEntries(CATEGORY_LANGS.map((l) => [l, c.texts.find((x) => x.lang === l)?.name ?? ""])),
});

function CategoriesTab() {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const { data, setData, error, reload } = useLoad(() => supportSettingsApi.categories());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const C = K.categories;

  if (!data) return <Loading error={error} reload={reload} />;

  /** Any write can flip `usingPlatform`, so the list is read again after each. */
  async function write(work: () => Promise<unknown>) {
    setBusy(true);
    setFailure(null);
    try {
      await work();
      setData((await supportSettingsApi.categories()) as CategoryList);
      setDraft(null);
    } catch (e) {
      setFailure(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function saveDraft(d: Draft) {
    const body = { key: d.key, sortOrder: d.sortOrder, isActive: d.isActive, texts: categoryTexts(d.names) };
    return write(() => (d.id ? supportSettingsApi.updateCategory(d.id, body) : supportSettingsApi.createCategory(body)));
  }

  const nameOf = (c: AdminCategory) => c.texts.find((x) => x.lang === "fa")?.name ?? c.texts[0]?.name ?? c.key;

  return (
    <section className="space-y-4 rounded-2xl border border-card-border bg-card-bg p-4">
      {data.usingPlatform ? (
        <div className="space-y-1 text-xs text-text-secondary">
          <p>{t("common", C.usingPlatform)}</p>
          <p className="font-bold text-text-primary">{data.platform.map((p) => p.name).join("، ")}</p>
        </div>
      ) : (
        <p className="text-xs text-text-secondary">{t("common", C.ownHint)}</p>
      )}

      {data.own.length === 0 ? (
        <p className="text-xs text-text-secondary">{t("common", C.empty)}</p>
      ) : (
        <ul className="divide-y divide-card-border">
          {data.own.map((c) =>
            draft?.id === c.id ? (
              <li key={c.id} className="py-3">
                <CategoryForm draft={draft} onChange={setDraft} onSave={saveDraft} onCancel={() => setDraft(null)} busy={busy} />
              </li>
            ) : (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-xs">
                <div>
                  <p dir="auto" className={`text-sm font-bold ${c.isActive ? "text-text-primary" : "text-text-secondary line-through"}`}>
                    {nameOf(c)}
                  </p>
                  <p className="font-mono text-text-secondary">
                    {c.key} · {c.sortOrder} · {t("common", c.isActive ? C.active : C.retired)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                  <Button variant="quiet" size="sm" disabled={busy} onClick={() => setDraft(draftOf(c))}>
                    {t("common", C.edit)}
                  </Button>
                  <Button variant="quiet" size="sm" disabled={busy} onClick={() => write(() => supportSettingsApi.updateCategory(c.id, { isActive: !c.isActive }))}>
                    {t("common", c.isActive ? C.retire : C.restore)}
                  </Button>
                  <Button
                    variant="quiet"
                    size="sm"
                    disabled={busy || c.inUse}
                    title={c.inUse ? t("common", C.inUse) : undefined}
                    onClick={() => write(() => supportSettingsApi.removeCategory(c.id))}
                    icon={<Trash2 size={12} aria-hidden />}
                  >
                    {t("common", C.delete)}
                  </Button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}

      {failure && <Alert tone="error">{failure}</Alert>}
      {draft && draft.id === null ? (
        <CategoryForm draft={draft} onChange={setDraft} onSave={saveDraft} onCancel={() => setDraft(null)} busy={busy} />
      ) : (
        <Button
          variant="primary"
          size="sm"
          disabled={busy}
          onClick={() =>
            setDraft({ id: null, key: "", sortOrder: (data.own.at(-1)?.sortOrder ?? 0) + 1, isActive: true, names: Object.fromEntries(CATEGORY_LANGS.map((l) => [l, ""])) })
          }
          icon={<Plus size={12} aria-hidden />}
        >
          {t("common", C.add)}
        </Button>
      )}
    </section>
  );
}

function CategoryForm({
  draft,
  onChange,
  onSave,
  onCancel,
  busy,
}: {
  draft: Draft;
  onChange: (d: Draft) => void;
  onSave: (d: Draft) => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const { t, availableLocales } = useLocale();
  const C = K.categories;
  const langName = (code: string) => availableLocales.find((l) => l.code === code)?.name ?? code;
  const ready = /^[a-z0-9_]{1,40}$/.test(draft.key) && categoryTexts(draft.names).length > 0;
  return (
    <div className="space-y-3 rounded-xl border border-card-border bg-bg-inner p-3 text-xs">
      {CATEGORY_LANGS.map((l) => (
        <label key={l} className="block font-bold text-text-primary">
          {t("common", C.name, { lang: langName(l) })}
          <Input dir="auto" className="mt-1" maxLength={80} value={draft.names[l] ?? ""} onChange={(e) => onChange({ ...draft, names: { ...draft.names, [l]: e.target.value } })} />
        </label>
      ))}
      <div className="flex flex-wrap gap-3">
        <label className="block font-bold text-text-primary">
          {t("common", C.key)}
          <Input dir="ltr" className="mt-1 font-mono" maxLength={40} value={draft.key} onChange={(e) => onChange({ ...draft, key: e.target.value.toLowerCase() })} />
          <span className="mt-1 block font-normal text-text-secondary">{t("common", C.keyHint)}</span>
        </label>
        <Field label={t("common", C.order)}>
          <Input dir="ltr" type="number" min={0} className="mt-1 w-24" value={draft.sortOrder} onChange={(e) => onChange({ ...draft, sortOrder: Number(e.target.value) })} />
        </Field>
        <Checkbox checked={draft.isActive} onChange={(on) => onChange({ ...draft, isActive: on })} label={t("common", C.active)} />
      </div>
      <div className="flex gap-2">
        <Button variant="primary" size="sm" disabled={busy || !ready} onClick={() => onSave(draft)}>
          {t("common", K.save)}
        </Button>
        <Button variant="quiet" size="sm" onClick={onCancel} disabled={busy}>
          {t("common", C.cancel)}
        </Button>
      </div>
    </div>
  );
}
