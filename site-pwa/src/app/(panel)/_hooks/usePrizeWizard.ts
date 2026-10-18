"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { useWizard, type WizardState } from "../_components/kit";
import { firstFailingStep, refusalStepOf, stepCheck, type PrizeFormCheck, type StepHolds } from "../_components/prizes/prize-steps";

const NOTHING_SHOWN: PrizeFormCheck<never, never> = { ok: true, fields: {}, prizes: [], overall: null };

export interface PrizeWizard<Form, S extends string, F extends string, P extends string> {
  form: Form;
  setForm: Dispatch<SetStateAction<Form>>;
  wizard: WizardState;
  step: S;
  goTo: (step: S) => void;
  /** What a step shows: its part of the check once Next was tried on it, else nothing. */
  shown: (step: S) => PrizeFormCheck<F, P>;
  /** The form differs from what it opened on: closing asks first (K9, K11). */
  dirty: boolean;
  saving: boolean;
  failure: string | null;
  /** Check every step, send, and on a refusal go back to the step that holds what it names. */
  submit: (send: (form: Form) => Promise<void>, message: (e: unknown) => string) => Promise<void>;
}

/**
 * The state of the wheel and lottery wizards (UX-3-c, UX-3-d): the form,
 * which steps have shown their errors, the save and its refusal. Next checks
 * only the step's own part of `checkOf` (`stepCheck`); the review checks it
 * all and sends the admin to the first step that fails. The rules stay the
 * form's validator's — this only cuts them by step.
 */
export function usePrizeWizard<Form, S extends string, F extends string, P extends string>({
  initial,
  steps,
  plan,
  checkOf,
  refusalSteps,
  start,
}: {
  initial: () => Form;
  steps: readonly S[];
  plan: Partial<Record<S, StepHolds<F>>>;
  checkOf: (form: Form) => PrizeFormCheck<F, P>;
  refusalSteps: Partial<Record<string, S>>;
  /** The step to open on; a saved draft opens on its review. */
  start?: S;
}): PrizeWizard<Form, S, F, P> {
  const [form, setForm] = useState<Form>(initial);
  const [opened] = useState(() => JSON.stringify(form));
  const [tried, setTried] = useState<readonly S[]>([]);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const check = checkOf(form);
  const holds = (s: S) => plan[s];

  const wizard = useWizard({
    count: steps.length,
    start: start ? steps.indexOf(start) : 0,
    validate: (i) => {
      const h = holds(steps[i]);
      if (!h || stepCheck(check, h).ok) return true;
      setTried((t) => [...t, steps[i]]);
      return false;
    },
    onMove: () => setFailure(null),
  });
  const goTo = (s: S) => wizard.goTo(steps.indexOf(s));

  const shown = (s: S) => {
    const h = holds(s);
    return h && tried.includes(s) ? stepCheck(check, h) : NOTHING_SHOWN;
  };

  const submit = async (send: (form: Form) => Promise<void>, message: (e: unknown) => string) => {
    const bad = firstFailingStep(check, plan);
    if (bad) {
      setTried(steps);
      goTo(bad);
      return;
    }
    setSaving(true);
    try {
      await send(form);
    } catch (e) {
      const back = refusalStepOf(refusalSteps, e);
      if (back) goTo(back);
      // After the move: a move clears the failure of the step it leaves.
      setFailure(message(e));
    } finally {
      setSaving(false);
    }
  };

  return { form, setForm, wizard, step: steps[wizard.index], goTo, shown, dirty: JSON.stringify(form) !== opened, saving, failure, submit };
}
