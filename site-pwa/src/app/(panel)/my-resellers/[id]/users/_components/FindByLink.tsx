"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Search, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { resellerGrantsApi, type BulkOutcomeRow, type ResellerGrantRow } from "@/lib/billing-api";
import { catalogApi } from "@/lib/catalog-api";
import { myResellerUserPath } from "@/lib/routes";
import { Pagination } from "../../../../_components/kit/Pagination";
import { formatInstant } from "../../../../_lib/datetime";
import { Alert, input, primaryButton, quietButton } from "../../../../catalog/_components/catalog-ui";
import { flattenTexts } from "../../../../catalog/_lib/catalog-form";
import { GRANT_TONES, pastedLines, serviceName } from "../../../../services/_lib/my-services";
import { GRANT_KEYS as G, emptyDraft, type GrantActionDraft } from "../../../_lib/grant-actions";
import { BULK_ACTIONS, BULK_KEYS as B, BULK_MAX_GRANTS, FIND_KEYS as F, bulkBody, bulkRefusalKey, toggleTicked, type BulkAction } from "../../../_lib/grant-bulk";
import { USER_KEYS } from "../../../_lib/users";
import { ActionFields } from "../[userId]/_components/GrantActions";
import { useUserMessage } from "../[userId]/_components/useUserMessage";

const PAGE_SIZE = 20;
const panel = "space-y-2 rounded-2xl border border-card-border bg-bg-inner p-3";
const button = "inline-flex items-center gap-1 rounded-xl border border-card-border bg-card-bg px-2.5 py-1.5 text-xs font-bold text-text-primary hover:bg-leaf-bg disabled:opacity-50";

/**
 * Find a service by a pasted config line or `/sub` link across the reseller's
 * own users (F-311-x over F-311-t), and act on the ticked ones at once
 * (F-311-u, -u1) — support is handed a link, not a phone number.
 *
 *  - **the paste is a body, never a URL** (a line is a credential), split as
 *    `/services` splits it (`pastedLines`, ≤20);
 *  - **each found service names its user**, and opens that user's sheet;
 *  - **a bulk act is one form, one `requestId`**: the form is the confirm, a
 *    reason is required, and a double click answers the first call's outcomes;
 *  - **an outcome per Grant**: the refused ones are named with their sentence,
 *    the rest done; then the search is read again.
 */
export function FindByLink({ id }: { id: string }) {
  const { t, lang } = useLocale();
  const message = useUserMessage();
  const api = useMemo(() => resellerGrantsApi(id), [id]);

  const [text, setText] = useState("");
  const [search, setSearch] = useState<{ lines: string[]; capped: boolean; page: number } | null>(null);
  const [answer, setAnswer] = useState<{ rows: ResellerGrantRow[]; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [noLinks, setNoLinks] = useState(false);
  const [asked, setAsked] = useState(0);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [ticked, setTicked] = useState<string[]>([]);
  // Every service seen, so a ticked one on another page is still named in its outcome.
  const [seen, setSeen] = useState<Record<string, ResellerGrantRow>>({});

  useEffect(() => {
    if (!search) return;
    let alive = true;
    api
      .byLines(search.lines, search.page, PAGE_SIZE, "current")
      .then((p) => {
        if (!alive) return;
        setAnswer({ rows: p.rows, total: p.total });
        setSeen((before) => ({ ...before, ...Object.fromEntries(p.rows.map((row) => [row.id, row])) }));
        setError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setAnswer(null);
        setError(e);
      })
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [api, search, asked]);

  // Read once the first search is made; a failed read leaves the SKU, as on `/services`.
  const wantTexts = search !== null;
  useEffect(() => {
    if (!wantTexts) return;
    let alive = true;
    catalogApi
      .texts(lang)
      .then(flattenTexts)
      .catch(() => ({}))
      .then((flat) => alive && setTexts(flat));
    return () => {
      alive = false;
    };
  }, [lang, wantTexts]);

  function find() {
    const { lines, capped } = pastedLines(text);
    setNoLinks(lines.length === 0);
    if (lines.length === 0) return;
    setTicked([]);
    setBusy(true);
    setSearch({ lines, capped, page: 1 });
  }

  function clear() {
    setText("");
    setSearch(null);
    setAnswer(null);
    setTicked([]);
    setError(null);
    setNoLinks(false);
  }

  const nameOf = (row: ResellerGrantRow) => serviceName(texts, row) ?? t("common", USER_KEYS.services.noPlan);

  return (
    <section aria-label={t("common", F.title)} className="space-y-3 rounded-2xl border border-card-border bg-card-bg p-4">
      <div>
        <p className="text-sm font-bold text-text-primary">{t("common", F.title)}</p>
        <p className="mt-1 text-xs text-text-secondary">{t("common", F.subtitle)}</p>
      </div>
      <form
        className="space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          find();
        }}
      >
        <textarea
          className={`${input} min-h-[72px] font-mono text-xs`}
          dir="ltr"
          value={text}
          placeholder={t("common", F.placeholder)}
          aria-label={t("common", F.title)}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex gap-2">
          <button type="submit" className={primaryButton} disabled={busy || text.trim() === ""}>
            {busy ? <Loader2 size={12} className="animate-spin" aria-hidden /> : <Search size={12} aria-hidden />}
            {t("common", F.submit)}
          </button>
          {search && (
            <button type="button" className={quietButton} onClick={clear}>
              <X size={12} aria-hidden />
              {t("common", F.clear)}
            </button>
          )}
        </div>
      </form>

      {noLinks && <p className="text-xs text-text-secondary">{t("common", F.noLinks)}</p>}
      {search?.capped && <p className="text-xs text-text-secondary">{t("common", F.capped, { count: search.lines.length })}</p>}
      {error !== null && <Alert>{message(error)}</Alert>}

      {answer !== null &&
        (answer.rows.length === 0 ? (
          <p className="text-xs text-text-secondary">{t("common", F.empty)}</p>
        ) : (
          <>
            <ul className="divide-y divide-card-border overflow-hidden rounded-2xl border border-card-border">
              {answer.rows.map((row) => {
                const tone = GRANT_TONES[row.status];
                return (
                  <li key={row.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                    <input
                      type="checkbox"
                      aria-label={t("common", F.tick)}
                      checked={ticked.includes(row.id)}
                      disabled={!ticked.includes(row.id) && ticked.length >= BULK_MAX_GRANTS}
                      onChange={() => setTicked((before) => toggleTicked(before, row.id))}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-bold text-text-primary" dir="auto">
                        {nameOf(row)}
                      </p>
                      <p className="text-xs text-text-secondary">
                        {row.endsAt
                          ? t("common", USER_KEYS.services.ends, { date: formatInstant(row.endsAt, lang, { withTime: false }) ?? "" })
                          : t("common", USER_KEYS.services.permanent)}
                      </p>
                    </div>
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${tone.className}`}>{t("common", tone.labelKey)}</span>
                    <Link href={myResellerUserPath(id, row.userId)} className={quietButton}>
                      {t("common", F.openUser)}
                      <ArrowLeft size={12} className="ltr:rotate-180" aria-hidden />
                    </Link>
                  </li>
                );
              })}
            </ul>
            {answer.total > PAGE_SIZE && search && (
              <Pagination
                page={search.page}
                totalPages={Math.ceil(answer.total / PAGE_SIZE)}
                totalItems={answer.total}
                pageSize={PAGE_SIZE}
                onPageChange={(page) => {
                  setBusy(true);
                  setSearch({ ...search, page });
                }}
              />
            )}
          </>
        ))}

      {ticked.length > 0 && (
        <BulkBar
          ticked={ticked}
          nameOf={(grantId) => (seen[grantId] ? nameOf(seen[grantId]) : grantId.slice(0, 8))}
          send={api.bulk}
          onUntick={() => setTicked([])}
          // The ticks stay: the outcome is shown under them, and a second act may follow.
          onActed={() => {
            setBusy(true);
            setAsked((n) => n + 1);
          }}
        />
      )}
    </section>
  );
}

/** The ticked services' one act: its fields, a required reason, and each Grant's outcome. */
function BulkBar({
  ticked,
  nameOf,
  send,
  onUntick,
  onActed,
}: {
  ticked: string[];
  nameOf: (grantId: string) => string;
  send: (body: Record<string, unknown>) => Promise<{ results: BulkOutcomeRow[] }>;
  onUntick: () => void;
  onActed: () => void;
}) {
  const { t } = useLocale();
  const message = useUserMessage();
  const [open, setOpen] = useState<BulkAction | null>(null);
  const [draft, setDraft] = useState<GrantActionDraft>(emptyDraft);
  const [busy, setBusy] = useState(false);
  const [outcomes, setOutcomes] = useState<BulkOutcomeRow[] | null>(null);
  const [error, setError] = useState<unknown>(null);

  const body = open ? bulkBody(open, ticked, draft) : null;
  const count = ticked.length;

  function start(action: BulkAction) {
    setOpen(action);
    // A new form, a new request: the same form sent twice is one act (F-311-u1).
    setDraft(emptyDraft());
    setError(null);
    setOutcomes(null);
  }

  async function submit() {
    if (!body || busy) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await send(body);
      setOutcomes(answer.results);
      setOpen(null);
      onActed();
    } catch (e) {
      // Refused whole — the door, the body or a reused request: no Grant was touched.
      console.error(e);
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const set = (patch: Partial<GrantActionDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const refused = outcomes?.filter((o): o is Extract<BulkOutcomeRow, { ok: false }> => !o.ok) ?? [];

  return (
    <div className={panel}>
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm font-bold text-text-primary">
          {t("common", B.title)} · {t("common", B.ticked, { count })}
        </p>
        <button type="button" className={quietButton} onClick={onUntick}>
          {t("common", B.untick)}
        </button>
      </div>
      {count >= BULK_MAX_GRANTS && <p className="text-xs text-text-secondary">{t("common", B.max, { count: BULK_MAX_GRANTS })}</p>}
      <div className="flex flex-wrap gap-1">
        {BULK_ACTIONS.map((action) => (
          <button key={action} type="button" className={button} disabled={busy} aria-pressed={open === action} onClick={() => start(action)}>
            {t("common", G.label[action])}
          </button>
        ))}
      </div>

      {open && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p className="text-xs text-text-secondary">{t("common", G.confirm[open])}</p>
          <p className="text-xs font-bold text-text-secondary">{t("common", B.confirm, { count })}</p>
          <ActionFields action={open} draft={draft} set={set} />
          <label className="block text-xs font-bold text-text-secondary">
            {t("common", G.field.reason)}
            <input
              className={`${input} mt-1`}
              value={draft.reason}
              maxLength={500}
              placeholder={t("common", G.field.reasonPlaceholder)}
              onChange={(e) => set({ reason: e.target.value })}
            />
          </label>
          <div className="flex gap-2">
            <button type="submit" className={primaryButton} disabled={busy || body === null}>
              {busy && <Loader2 size={12} className="animate-spin" aria-hidden />}
              {t("common", B.submit, { count })}
            </button>
            <button type="button" className={quietButton} onClick={() => setOpen(null)}>
              {t("common", USER_KEYS.actions.cancel)}
            </button>
          </div>
        </form>
      )}

      {outcomes && (
        <div role="status" className="space-y-1 rounded-2xl bg-leaf-bg px-3 py-2 text-xs font-bold text-primary">
          <p>{t("common", B.done, { ok: outcomes.length - refused.length, refused: refused.length })}</p>
          {refused.map((o) => (
            <p key={o.grantId} className="font-normal text-error">
              {t("common", B.refusalLine, { name: nameOf(o.grantId), reason: t("common", bulkRefusalKey(o.reason)) })}
            </p>
          ))}
        </div>
      )}
      {error !== null && <Alert>{message(error)}</Alert>}
    </div>
  );
}
