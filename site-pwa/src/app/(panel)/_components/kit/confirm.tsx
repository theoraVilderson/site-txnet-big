"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { Button } from "./Button";
import { Dialog } from "./Dialog";
import { Field, Input } from "./Field";

const K = FrontendI18nKeys.common.kit.confirm;

export interface ConfirmOptions {
  title: ReactNode;
  body?: ReactNode;
  /** The confirm button's label — the verb ("Delete"), never "OK". */
  confirmLabel?: string;
  /** `danger` for what cannot be undone; a dirty-close question is `default` (K9). */
  tone?: "default" | "danger";
  /**
   * The object's name, which the person must type before confirming. Only for
   * the five actions K9 lists — a gateway deleted, categories holding products
   * deleted, two or more configs retired, a package's product unlisted,
   * emergency support access.
   */
  typeToConfirm?: string;
}

type Ask = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Ask | null>(null);

/**
 * Asks a question in the kit's dialog and answers with a promise of a boolean
 * (UX-1-d, `contract.ux.md` K9) — the replacement for `window.confirm`, which
 * cannot be styled, translated or made to show what is at stake.
 */
export function useConfirm(): Ask {
  const ask = useContext(ConfirmContext);
  if (!ask) throw new Error("useConfirm must be used inside <ConfirmProvider> (the panel layout mounts one)");
  return ask;
}

/** One question at a time, for the whole panel; mounted at the panel layout. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  // Kept after closing so the dialog's exit animation still has its words.
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const [typed, setTyped] = useState("");
  const pending = useRef<((answer: boolean) => void) | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const typeRef = useRef<HTMLInputElement>(null);

  const answer = useCallback((value: boolean) => {
    pending.current?.(value);
    pending.current = null;
    setOpen(false);
  }, []);

  const ask = useCallback<Ask>((next) => {
    // A second question while one is open answers the first "no".
    pending.current?.(false);
    setOptions(next);
    setTyped("");
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      pending.current = resolve;
    });
  }, []);

  const danger = options?.tone === "danger";
  const blocked = options?.typeToConfirm !== undefined && typed.trim() !== options.typeToConfirm;
  // Where a slip of Enter would hurt, focus starts on the safe answer.
  const initialFocusRef = options?.typeToConfirm !== undefined ? typeRef : danger ? cancelRef : confirmRef;

  return (
    <ConfirmContext.Provider value={ask}>
      {children}
      <Dialog
        open={open}
        onClose={() => answer(false)}
        title={options?.title}
        size="sm"
        hideClose
        initialFocusRef={initialFocusRef}
        footer={
          <>
            <Button ref={cancelRef} variant="quiet" onClick={() => answer(false)}>
              {t("common", K.cancel)}
            </Button>
            <Button ref={confirmRef} variant={danger ? "danger" : "primary"} disabled={blocked} onClick={() => answer(true)}>
              {options?.confirmLabel ?? t("common", K.confirm)}
            </Button>
          </>
        }
      >
        {options?.body && <div className="text-sm text-text-secondary">{options.body}</div>}
        {options?.typeToConfirm !== undefined && (
          <form
            className="mt-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!blocked) answer(true);
            }}
          >
            <Field label={t("common", K.typeToConfirm, { name: options.typeToConfirm })}>
              <Input ref={typeRef} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
            </Field>
          </form>
        )}
      </Dialog>
    </ConfirmContext.Provider>
  );
}
