"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { motion } from "framer-motion";
import { ImageUp } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { ApiError } from "@/lib/api-error";
import { billingApi } from "@/lib/billing-api";
import { DURATION } from "@/lib/motion";
import { Button } from "../../../_components/kit";
import { PAY_KEYS, PROOF_REFUSAL_KEYS } from "../_lib/transfer-page";

const K = PAY_KEYS.proof;
/** Billing's receipt policy (`RECEIPT_POLICY`): what it stores, checked here before the bytes travel. */
const RECEIPT_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/webp"];
const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The receipt (contract "Proof"): dropped, pasted from the clipboard, or
 * chosen; checked for type and size before it is sent, uploaded at once with a
 * bar while it travels, then previewed scaling in. A second image replaces the
 * first — billing keeps one per payment. `onUploaded` gets billing's key.
 */
export function ReceiptDrop({ paymentId, onUploaded, invalid }: { paymentId: string; onUploaded: (key: string | null) => void; invalid?: boolean }) {
  const { t } = useLocale();
  const errorMessage = useApiErrorMessage();
  const level = useMotionLevel();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  const take = async (file: File | undefined) => {
    if (!file || uploading) return;
    if (!RECEIPT_TYPES.includes(file.type)) return setError(t("common", K.wrongType));
    if (file.size > RECEIPT_MAX_BYTES) return setError(t("common", K.tooBig));
    setError(null);
    setUploading(true);
    onUploaded(null);
    try {
      const { key } = await billingApi.uploadTransferReceipt(paymentId, file);
      setPreview(URL.createObjectURL(file));
      onUploaded(key);
    } catch (e) {
      const reason = e instanceof ApiError ? e.reason : undefined;
      setError(reason && reason in PROOF_REFUSAL_KEYS ? t("common", PROOF_REFUSAL_KEYS[reason]) : errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  // A screenshot pasted anywhere on the page is the receipt: the quickest path on a desktop.
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      const file = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
      if (file) void take(file);
    };
    document.addEventListener("paste", paste);
    return () => document.removeEventListener("paste", paste);
  });

  const drop = (e: DragEvent) => {
    e.preventDefault();
    void take(e.dataTransfer.files[0]);
  };

  return (
    <div className="flex flex-col gap-2">
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={drop}
        className={`relative flex flex-col items-center gap-3 overflow-hidden rounded-2xl border-2 border-dashed p-5 text-center ${
          invalid || error ? "border-error-border" : "border-card-border"
        }`}
      >
        {preview ? (
          <motion.img
            src={preview}
            alt={t("common", FrontendI18nKeys.common.transfer.proof.receiptImage)}
            initial={level === "full" ? { opacity: 0, scale: 0.85 } : { opacity: 0 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: level === "full" ? DURATION.base : DURATION.fast }}
            className="max-h-48 rounded-xl object-contain"
          />
        ) : (
          <ImageUp size={28} aria-hidden className="text-text-secondary" />
        )}
        <p className="text-xs text-text-secondary">
          {t("common", K.drop)}{" "}
          <Button variant="quiet" size="sm" onClick={() => input.current?.click()} disabled={uploading} className="inline-flex text-primary">
            {preview ? t("common", K.replace) : t("common", K.choose)}
          </Button>
        </p>
        <p className="text-3xs text-text-secondary">{t("common", K.types)}</p>
        <input ref={input} type="file" accept={RECEIPT_TYPES.join(",")} className="sr-only" tabIndex={-1} onChange={(e) => void take(e.target.files?.[0])} />
        {uploading && (
          <div role="progressbar" aria-label={t("common", K.uploading)} className="absolute inset-x-0 bottom-0 h-1 overflow-hidden bg-card-border">
            <span className="transfer-upload-bar block h-full bg-primary" />
          </div>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs font-bold text-error">
          {error}
        </p>
      )}
    </div>
  );
}
