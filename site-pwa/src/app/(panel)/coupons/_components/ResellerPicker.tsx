"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { Search } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { tenantApi, type Reseller } from "@/lib/tenant-api";
import { COUPON_KEYS } from "../_lib/coupon-form";
import { Button, Input } from "../../_components/kit";

const R = COUPON_KEYS.form.resellerPicker;

/** `GET /tenants`'s own maximum page (`listResellersSchema`); the route has no search, so the page is filtered here. */
const RESELLER_PAGE = 100;

type Loaded = { items: Reseller[]; more: boolean } | null | "failed";

/** Whether a reseller matches the typed text — its slug, owner or a domain. */
function matches(r: Reseller, text: string): boolean {
  const q = text.trim().toLowerCase();
  if (!q) return true;
  return [r.slug, r.owner?.fullName, r.owner?.username, ...r.domains.map((d) => d.domainValue)].some((v) => v?.toLowerCase().includes(q));
}

/** One page appended to what is held; a refused first page is `"failed"`, a refused later one keeps the list. */
function readPage(offset: number, setLoaded: Dispatch<SetStateAction<Loaded>>) {
  return tenantApi.resellers(RESELLER_PAGE, offset).then(
    (page) => setLoaded((prev) => ({ items: [...(offset > 0 && prev && prev !== "failed" ? prev.items : []), ...page], more: page.length === RESELLER_PAGE })),
    () => setLoaded((prev) => (offset > 0 ? prev : "failed")),
  );
}

/**
 * The reseller a platform coupon or gift batch belongs to (UX-3-a), picked by
 * slug, owner or domain instead of a typed tenant id; the form still sends
 * the id. `/tenants` pages newest first with no search, so the list is read a
 * page at a time ("more") and filtered on the page. A caller the route
 * refuses types the id, as before.
 */
export function ResellerPicker({ id, value, onChange, invalid = false }: { id: string; value: string; onChange: (tenantId: string) => void; invalid?: boolean }) {
  const { t } = useLocale();
  const [loaded, setLoaded] = useState<Loaded>(null);
  const [text, setText] = useState("");

  useEffect(() => void readPage(0, setLoaded), []);

  if (loaded === null) return <p className="py-2.5 text-xs text-text-secondary">{t("common", R.loading)}</p>;
  if (loaded === "failed")
    return <Input id={id} dir="ltr" aria-invalid={invalid} value={value} onChange={(e) => onChange(e.target.value.trim())} placeholder={t("common", R.byId)} />;

  if (value) {
    const picked = loaded.items.find((r) => r.id === value);
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-primary/30 bg-bg-inner px-3 py-2">
        {picked ? <ResellerLine r={picked} /> : <span className="truncate font-mono text-xs text-text-primary" dir="ltr">{value}</span>}
        <Button variant="quiet" size="sm" onClick={() => onChange("")}>
          {t("common", R.change)}
        </Button>
      </div>
    );
  }

  const shown = loaded.items.filter((r) => matches(r, text));
  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <Search size={14} className="pointer-events-none absolute top-1/2 -translate-y-1/2 text-text-secondary start-3" aria-hidden />
        <Input id={id} className="ps-8" aria-invalid={invalid} value={text} placeholder={t("common", R.search)} onChange={(e) => setText(e.target.value)} />
      </div>
      {shown.length === 0 ? (
        <p className="text-xs text-text-secondary">{t("common", R.none)}</p>
      ) : (
        <ul className="flex max-h-56 flex-col divide-y divide-card-border overflow-y-auto rounded-xl border border-card-border">
          {shown.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => onChange(r.id)} className="flex w-full items-center px-3 py-2 text-start hover:bg-[var(--leaf-bg)]">
                <ResellerLine r={r} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {loaded.more && (
        <Button variant="quiet" size="sm" onClick={() => void readPage(loaded.items.length, setLoaded)} className="self-start text-primary hover:text-primary">
          {t("common", R.more)}
        </Button>
      )}
    </div>
  );
}

function ResellerLine({ r }: { r: Reseller }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate text-sm font-bold text-text-primary" dir="ltr">
        {r.slug}
      </span>
      {r.owner && <span className="truncate text-xs text-text-secondary">{r.owner.fullName}</span>}
    </span>
  );
}
