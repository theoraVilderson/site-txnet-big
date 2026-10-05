"use client";

import { useMemo, useRef, useState, type DragEvent, type ReactNode } from "react";
import { FileText, Upload, X } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { SUPPORT_FILE_TYPES } from "@/lib/support-api";
import { cn } from "../../_components/kit";
import { SUPPORT_KEYS as K, fileSize } from "../_lib/support";

/** Draws an image file into its `<img>`: an object URL made on mount and revoked when it goes. */
const objectUrlInto = (file: File) => (img: HTMLImageElement | null) => {
  if (!img || typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(file);
  img.src = url;
  return () => URL.revokeObjectURL(url);
};

/** Files about to be sent: images as thumbnails, the rest as a name and size; each can be taken back. */
export function PendingFiles({ files, onRemove, disabled }: { files: readonly File[]; onRemove: (index: number) => void; disabled?: boolean }) {
  if (files.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2">
      {files.map((f, i) => (
        <PendingFile key={`${f.name}-${f.size}-${i}`} file={f} disabled={disabled} onRemove={() => onRemove(i)} />
      ))}
    </ul>
  );
}

function PendingFile({ file, onRemove, disabled }: { file: File; onRemove: () => void; disabled?: boolean }) {
  const { t } = useLocale();
  const image = file.type.startsWith("image/");
  // One URL per file, not per render: a new ref callback would revoke and mint again on each.
  const drawInto = useMemo(() => objectUrlInto(file), [file]);
  const size = fileSize(file.size);
  return (
    <li className="relative">
      {image ? (
        // eslint-disable-next-line @next/next/no-img-element -- a local object URL, nothing for next/image to optimise
        <img ref={drawInto} alt={file.name} className="size-16 rounded-xl border border-card-border object-cover" />
      ) : (
        <span className="flex h-16 max-w-[12rem] items-center gap-1 rounded-xl border border-card-border bg-bg-inner px-2 text-xs text-text-primary">
          <FileText size={14} className="shrink-0" aria-hidden />
          <span dir="auto" className="truncate">
            {file.name}
          </span>
          <span className="shrink-0 text-text-secondary">({t("common", size.key, { n: size.n })})</span>
        </span>
      )}
      <button
        type="button"
        disabled={disabled}
        aria-label={`${t("common", K.thread.removeFile)} ${file.name}`}
        onClick={onRemove}
        className="absolute -end-1.5 -top-1.5 grid size-5 place-items-center rounded-full border border-card-border bg-card-bg text-text-secondary shadow-sm hover:text-error"
      >
        <X size={12} aria-hidden />
      </button>
    </li>
  );
}

/** Files dragged over `children`'s box land in `onFiles`; `active` says one is over it now. */
export function useFileDrop(onFiles: (files: File[]) => void, disabled = false) {
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  const carriesFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  return {
    active,
    handlers: {
      onDragEnter: (e: DragEvent) => {
        if (disabled || !carriesFiles(e)) return;
        e.preventDefault();
        depth.current += 1;
        setActive(true);
      },
      onDragOver: (e: DragEvent) => {
        if (disabled || !carriesFiles(e)) return;
        e.preventDefault();
      },
      onDragLeave: () => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setActive(false);
      },
      onDrop: (e: DragEvent) => {
        depth.current = 0;
        setActive(false);
        if (disabled || !carriesFiles(e)) return;
        e.preventDefault();
        onFiles(Array.from(e.dataTransfer.files));
      },
    },
  };
}

/** A box to drop files on or click to choose them — the new ticket's (UX-1-w, T3). */
export function FileDropZone({ onFiles, disabled, testId, children }: { onFiles: (files: File[]) => void; disabled?: boolean; testId?: string; children?: ReactNode }) {
  const { t } = useLocale();
  const picker = useRef<HTMLInputElement>(null);
  const drop = useFileDrop(onFiles, disabled);
  return (
    <div
      {...drop.handlers}
      className={cn(
        "rounded-2xl border-2 border-dashed p-4 transition-colors",
        drop.active ? "border-[var(--accent-primary)] bg-[var(--leaf-bg)]" : "border-card-border",
      )}
    >
      <input
        ref={picker}
        data-testid={testId}
        type="file"
        multiple
        hidden
        accept={SUPPORT_FILE_TYPES.join(",")}
        onChange={(e) => {
          onFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={() => picker.current?.click()}
        className="flex w-full flex-col items-center gap-1 rounded-xl py-2 text-center text-sm text-text-secondary hover:text-text-primary"
      >
        <Upload size={20} className="text-primary" aria-hidden />
        <span className="font-bold">{t("common", K.ticket.filesDrop)}</span>
        <span className="text-[11px]">{t("common", K.thread.attachHint)}</span>
      </button>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}
