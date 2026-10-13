"use client";

import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, ArrowUp, ArrowUpDown, MoreVertical, X } from "lucide-react";
import type { ReactNode } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { DURATION, EASE } from "@/lib/motion";
import { IconButton } from "./Button";
import { cn } from "./cn";
import { Menu, type MenuItem } from "./Menu";

const K = FrontendI18nKeys.common.kit.table;

/** On a card a row shows its first column as the title and at most this many more (K13). */
const CARD_FIELDS = 4;

export interface DataColumn<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** The cell's own classes, in the table and as a card value. */
  className?: string;
  /** `ltr` for a figure, a code or a slug inside Persian text. */
  dir?: "ltr" | "auto";
  /** The header asks the page to sort by this column (`onSort`); only where the page already sorts. */
  sortable?: boolean;
  /** Left off the card — a column that says nothing on its own at phone width. */
  hideOnCard?: boolean;
}

export interface DataTableSelection {
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
  /** What the bulk bar offers for the rows ticked. */
  actions: ReactNode;
}

export interface DataTableProps<T> {
  /** The table's accessible name. */
  label: string;
  rows: readonly T[];
  columns: readonly DataColumn<T>[];
  rowKey: (row: T) => string;
  /** A row's actions: one `Menu`, at the end of the row and at the top of its card. */
  actions?: (row: T) => readonly MenuItem[];
  sort?: { column: string; direction: "asc" | "desc" };
  onSort?: (column: string) => void;
  selection?: DataTableSelection;
  /** Shown in place of the table when there are no rows. */
  empty?: ReactNode;
  /** Smaller type and padding, for a table inside a card or a sheet. */
  compact?: boolean;
  /** No border or background of its own — it already sits inside one. */
  bare?: boolean;
  /** The table's least width before it scrolls sideways, e.g. `min-w-[720px]`. */
  minWidth?: string;
  /** Classes on every `<tr>`, e.g. `align-top`. */
  rowClassName?: string;
}

/**
 * A list of records (UX-1-g, `contract.ux.md` K13): a table from `md` up, and
 * below it one card per row — the first column as its title, up to four more
 * as label : value. Both are drawn and CSS shows one, so the server's first
 * paint is already the right one. Ticking rows raises a bulk-action bar that
 * stays in view while the list scrolls.
 */
export function DataTable<T>({
  label,
  rows,
  columns,
  rowKey,
  actions,
  sort,
  onSort,
  selection,
  empty,
  compact = false,
  bare = false,
  minWidth,
  rowClassName,
}: DataTableProps<T>) {
  const { t } = useLocale();
  const level = useMotionLevel();

  if (rows.length === 0 && empty !== undefined) return <>{empty}</>;

  const [title, ...rest] = columns;
  const cardFields = rest.filter((c) => !c.hideOnCard && c.header !== "" && c.header !== null).slice(0, CARD_FIELDS);
  const keys = rows.map(rowKey);
  const selected = selection?.selected ?? new Set<string>();
  const allTicked = keys.length > 0 && keys.every((k) => selected.has(k));
  const someTicked = keys.some((k) => selected.has(k));

  const tick = (key: string, on: boolean) => {
    if (!selection) return;
    const next = new Set(selection.selected);
    if (on) next.add(key);
    else next.delete(key);
    selection.onChange(next);
  };
  const tickAll = (on: boolean) => selection?.onChange(on ? new Set([...selection.selected, ...keys]) : new Set([...selection.selected].filter((k) => !keys.includes(k))));

  const cell = compact ? "px-2 py-2" : "px-3 py-2.5";
  const menu = (row: T) => {
    const items = actions?.(row);
    if (!items || items.length === 0) return null;
    return <Menu label={t("common", K.actions)} items={items} trigger={<IconButton aria-label={t("common", K.actions)} icon={<MoreVertical size={16} aria-hidden />} variant="quiet" size="sm" />} />;
  };
  const ariaSort = (c: DataColumn<T>) => (sort?.column === c.id ? (sort.direction === "asc" ? "ascending" : "descending") : undefined);
  const SortIcon = (c: DataColumn<T>) => {
    const Icon = sort?.column !== c.id ? ArrowUpDown : sort.direction === "asc" ? ArrowUp : ArrowDown;
    return <Icon size={12} aria-hidden className={sort?.column === c.id ? "text-primary" : "opacity-50"} />;
  };

  return (
    <>
      <div className={cn("hidden overflow-x-auto md:block", !bare && "rounded-2xl border border-card-border bg-card-bg")}>
        <table aria-label={label} className={cn("w-full", compact ? "text-xs" : "text-sm", minWidth)}>
          <thead className={cn("text-2xs text-text-secondary", !bare && "bg-bg-inner/50")}>
            <tr>
              {selection && (
                <th scope="col" className={cn(cell, "w-10")}>
                  <TickBox
                    label={t("common", K.selectAll)}
                    checked={allTicked}
                    indeterminate={someTicked && !allTicked}
                    onChange={tickAll}
                  />
                </th>
              )}
              {columns.map((c) => (
                <th key={c.id} scope="col" aria-sort={ariaSort(c)} className={cn(cell, "text-start font-bold")}>
                  {c.sortable && onSort ? (
                    <button type="button" onClick={() => onSort(c.id)} className="inline-flex items-center gap-1 rounded-md hover:text-text-primary">
                      {c.header}
                      {SortIcon(c)}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              ))}
              {actions && <th scope="col" className={cn(cell, "w-12")} />}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const key = keys[i];
              const ticked = selected.has(key);
              return (
                <tr key={key} className={cn("border-t border-card-border transition-colors hover:bg-bg-inner", ticked && "bg-leaf-bg", rowClassName)}>
                  {selection && (
                    <td className={cell}>
                      <TickBox label={t("common", K.selectRow)} checked={ticked} onChange={(on) => tick(key, on)} />
                    </td>
                  )}
                  {columns.map((c) => (
                    <td key={c.id} dir={c.dir} className={cn(cell, "text-start", c.className)}>
                      {c.cell(row)}
                    </td>
                  ))}
                  {actions && <td className={cn(cell, "text-end")}>{menu(row)}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ul aria-label={label} className="flex flex-col gap-2 md:hidden">
        {rows.map((row, i) => {
          const key = keys[i];
          const ticked = selected.has(key);
          return (
            <li key={key} className={cn("rounded-2xl border border-card-border bg-card-bg p-3", ticked && "border-primary bg-leaf-bg")}>
              <div className="flex items-start gap-2">
                {selection && <TickBox label={t("common", K.selectRow)} checked={ticked} onChange={(on) => tick(key, on)} className="mt-0.5" />}
                <h3 dir={title.dir} className={cn("min-w-0 flex-1 text-sm font-bold text-text-primary", title.className)}>
                  {title.cell(row)}
                </h3>
                {menu(row)}
              </div>
              {cardFields.length > 0 && (
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-xs">
                  {cardFields.map((c) => (
                    <div key={c.id} className="contents">
                      <dt className="text-text-secondary">{c.header}</dt>
                      <dd dir={c.dir} className={cn("min-w-0 text-end text-text-primary", c.className)}>
                        {c.cell(row)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          );
        })}
      </ul>

      <AnimatePresence>
        {selection && selection.selected.size > 0 && (
          <motion.div
            key="bulk"
            role="region"
            aria-label={t("common", K.selected, { count: selection.selected.size })}
            initial={level === "reduced" ? { opacity: 0 } : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: DURATION.fast, ease: EASE.exit } }}
            transition={{ duration: DURATION.base, ease: EASE.standard }}
            className="sticky bottom-4 z-30 mx-auto mt-3 flex w-full max-w-xl flex-wrap items-center gap-2 rounded-2xl border border-card-border bg-card-bg p-2 ps-4 shadow-xl"
          >
            <span className="flex-1 text-sm font-bold text-text-primary">{t("common", K.selected, { count: selection.selected.size })}</span>
            {selection.actions}
            <IconButton variant="quiet" size="sm" aria-label={t("common", K.clear)} icon={<X size={14} aria-hidden />} onClick={() => selection.onChange(new Set())} />
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function TickBox({
  label,
  checked,
  indeterminate = false,
  onChange,
  className,
}: {
  label: string;
  checked: boolean;
  indeterminate?: boolean;
  onChange: (on: boolean) => void;
  className?: string;
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = indeterminate;
      }}
      onChange={(e) => onChange(e.target.checked)}
      className={cn("size-4 shrink-0 cursor-pointer rounded accent-[var(--accent-primary)]", className)}
    />
  );
}
