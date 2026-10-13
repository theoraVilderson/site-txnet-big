"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowRight, BookOpen, Check, Send } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";
import { FrontendI18nKeys } from "@/generated/i18n-keys";
import { useApiErrorMessage } from "@/hooks/useApiError";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { DURATION, EASE } from "@/lib/motion";
import { SUPPORT_BODY_MAX, supportApi, type SupportCategory, type SupportConversation } from "@/lib/support-api";
import { Alert, Button, Field, Input, RadioCards, Sheet, Textarea, notify, useConfirm, useWizard } from "../../_components/kit";
import { Skeleton } from "../../_components/kit/Skeleton";
import { SUPPORT_KEYS as K, acceptSupportFiles } from "../_lib/support";
import { SupportGuideSuggestions } from "./SupportGuideSuggestions";
import { FileDropZone, PendingFiles } from "./SupportFiles";

const W = FrontendI18nKeys.common.kit.wizard;

type StepId = "category" | "message" | "guides";

export interface NewTicketSheetProps {
  open: boolean;
  onClose: () => void;
  /** The thread is open; `filesFailed` when it opened but its files did not go with it. */
  onOpened: (conversation: SupportConversation, outcome: { filesFailed: boolean }) => void;
}

/**
 * A new ticket (UX-1-w, `contract.ux.md` T3): a `Sheet` walked in steps by
 * `useWizard` — the category as cards (skipped when the tenant has none), the
 * message with its files, then the guides that may already answer it.
 *
 * Not the kit `Wizard`: that is a dialog of its own with one submit, and the
 * last step here has two ways out — send, or "this solved it", which closes
 * and sends nothing. Files go after the thread opens, as support takes them;
 * a failed attach still opens the thread, and says so there.
 */
export function NewTicketSheet({ open, onClose, onOpened }: NewTicketSheetProps) {
  const { t, isRtl } = useLocale();
  const errorMessage = useApiErrorMessage();
  const confirm = useConfirm();
  const level = useMotionLevel();

  const [categories, setCategories] = useState<SupportCategory[] | null>(null);
  const [categoryId, setCategoryId] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [refused, setRefused] = useState<string[]>([]);
  const [invalid, setInvalid] = useState<StepId | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    supportApi
      .categories()
      .then((c) => alive && setCategories(c))
      // No categories to offer is a step skipped, never an error over the form.
      .catch(() => alive && setCategories([]));
    return () => {
      alive = false;
    };
  }, [open]);

  const steps: StepId[] = categories && categories.length > 0 ? ["category", "message", "guides"] : ["message", "guides"];
  const wizard = useWizard({
    count: steps.length,
    validate: (i) => {
      const step = steps[i];
      const ok = step === "category" ? categoryId !== "" : step === "message" ? body.trim() !== "" : true;
      setInvalid(ok ? null : step);
      return ok;
    },
    onMove: () => setFailure(null),
  });

  // Closed, it forgets: the next open starts at the first step with nothing in it.
  const close = () => {
    setCategories(null);
    setCategoryId("");
    setSubject("");
    setBody("");
    setFiles([]);
    setRefused([]);
    setInvalid(null);
    setFailure(null);
    setBusy(false);
    wizard.reset();
    onClose();
  };

  const dirty = categoryId !== "" || subject.trim() !== "" || body.trim() !== "" || files.length > 0;
  const requestClose = async () => {
    if (busy) return;
    if (dirty && !(await confirm({ title: t("common", K.ticket.closeQuestion), confirmLabel: t("common", W.leave) }))) return;
    close();
  };

  function addFiles(picked: File[]) {
    const { accepted, refused: names } = acceptSupportFiles(picked);
    setFiles((held) => [...held, ...accepted]);
    setRefused(names);
  }

  async function send() {
    setBusy(true);
    setFailure(null);
    let opened: SupportConversation;
    try {
      opened = await supportApi.open({ body, subject: subject.trim() || undefined, categoryId: categoryId || undefined });
    } catch (e) {
      setFailure(errorMessage(e));
      setBusy(false);
      return;
    }
    let filesFailed = false;
    if (files.length > 0) {
      try {
        await supportApi.attach(opened.id, files);
      } catch {
        filesFailed = true;
      }
    }
    close();
    onOpened(opened, { filesFailed });
  }

  function solved() {
    notify.success(t("common", K.ticket.solvedToast));
    close();
  }

  const index = Math.min(wizard.index, steps.length - 1);
  const step = steps[index];
  const last = index === steps.length - 1;
  const reduced = level === "reduced";
  const slide = reduced ? { opacity: 0 } : { x: wizard.direction * (isRtl ? -24 : 24), opacity: 0 };
  const BackIcon = isRtl ? ArrowRight : ArrowLeft;
  const NextIcon = isRtl ? ArrowLeft : ArrowRight;
  const stepTitle: Record<StepId, string> = {
    category: t("common", K.ticket.stepCategory),
    message: t("common", K.ticket.stepMessage),
    guides: t("common", K.ticket.stepGuides),
  };
  const stepHint: Record<StepId, string> = {
    category: t("common", K.ticket.stepCategoryHint),
    message: t("common", K.ticket.stepMessageHint),
    guides: t("common", K.ticket.stepGuidesHint),
  };

  const footer = categories && (
    <div className="flex items-center justify-between gap-2">
      {index > 0 ? (
        <Button variant="quiet" icon={<BackIcon size={16} aria-hidden />} disabled={busy} onClick={() => wizard.goTo(index - 1)}>
          {t("common", W.back)}
        </Button>
      ) : (
        <Button variant="quiet" onClick={() => void requestClose()}>
          {t("common", W.cancel)}
        </Button>
      )}
      {last ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="secondary" icon={<Check size={16} aria-hidden />} disabled={busy} onClick={solved}>
            {t("common", K.ticket.solved)}
          </Button>
          <Button loading={busy} icon={<Send size={16} className="rtl:-scale-x-100" aria-hidden />} onClick={() => void send()}>
            {t("common", K.ticket.send)}
          </Button>
        </div>
      ) : (
        <Button iconEnd={<NextIcon size={16} aria-hidden />} onClick={() => wizard.next()}>
          {t("common", W.next)}
        </Button>
      )}
    </div>
  );

  return (
    <Sheet
      open={open}
      onClose={() => void requestClose()}
      width="lg"
      title={t("common", K.ticket.title)}
      description={categories && t("common", W.stepOf, { current: String(index + 1), total: String(steps.length) })}
      footer={footer}
    >
      {!categories ? (
        <Skeleton className="h-40 w-full rounded-2xl" />
      ) : (
        <div className="space-y-5">
          <ol className="flex gap-2" aria-hidden>
            {steps.map((s, i) => (
              <li key={s} className="min-w-0 flex-1 space-y-1">
                <div className="h-1.5 overflow-hidden rounded-full bg-[var(--leaf-bg)]">
                  <motion.div
                    className="h-full rounded-full bg-primary"
                    initial={false}
                    animate={{ width: i <= index ? "100%" : "0%" }}
                    transition={{ duration: reduced ? 0 : DURATION.slow, ease: EASE.standard }}
                  />
                </div>
                <p className={`truncate text-2xs font-bold ${i === index ? "text-text-primary" : "text-text-secondary"}`}>{stepTitle[s]}</p>
              </li>
            ))}
          </ol>

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={step}
              initial={slide}
              animate={{ x: 0, opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduced ? DURATION.fast : DURATION.base, ease: EASE.standard }}
              className="space-y-4"
            >
              <div>
                <h3 className="text-base font-bold text-text-primary">{stepTitle[step]}</h3>
                <p className="text-xs text-text-secondary">{stepHint[step]}</p>
              </div>

              {step === "category" && (
                <>
                  <RadioCards
                    ariaLabel={t("common", K.form.category)}
                    value={categoryId}
                    onChange={(v) => {
                      setCategoryId(v);
                      setInvalid(null);
                    }}
                    options={(categories ?? []).map((c) => ({ value: c.id, label: c.name }))}
                  />
                  {invalid === "category" && <Alert tone="error">{t("common", K.ticket.categoryRequired)}</Alert>}
                </>
              )}

              {step === "message" && (
                <>
                  <Field label={t("common", K.form.subject)} hint={t("common", K.form.subjectHint)} optional>
                    <Input dir="auto" value={subject} maxLength={120} onChange={(e) => setSubject(e.target.value)} />
                  </Field>
                  <Field label={t("common", K.form.body)} error={invalid === "message" ? t("common", K.ticket.bodyRequired) : undefined}>
                    <Textarea
                      dir="auto"
                      rows={6}
                      value={body}
                      maxLength={SUPPORT_BODY_MAX}
                      onChange={(e) => {
                        setBody(e.target.value);
                        if (e.target.value.trim()) setInvalid(null);
                      }}
                    />
                  </Field>
                  <div className="space-y-2">
                    <p className="text-xs font-bold text-text-primary">{t("common", K.ticket.files)}</p>
                    <FileDropZone onFiles={addFiles} disabled={busy} testId="ticket-files">
                      <PendingFiles files={files} disabled={busy} onRemove={(i) => setFiles((held) => held.filter((_, j) => j !== i))} />
                    </FileDropZone>
                    {refused.length > 0 && <Alert tone="warning">{t("common", K.ticket.filesRefused, { names: refused.join(", ") })}</Alert>}
                  </div>
                </>
              )}

              {step === "guides" && (
                <SupportGuideSuggestions
                  subject={subject}
                  body={body}
                  empty={
                    <p className="flex items-center gap-2 rounded-2xl border border-card-border bg-bg-inner p-4 text-sm text-text-secondary">
                      <BookOpen size={16} className="shrink-0" aria-hidden />
                      {t("common", K.ticket.noGuides)}
                    </p>
                  }
                />
              )}

              {failure && <Alert tone="error">{failure}</Alert>}
            </motion.div>
          </AnimatePresence>
        </div>
      )}
    </Sheet>
  );
}
