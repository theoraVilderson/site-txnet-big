import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { AuthTranslations } from '@auth/auth/_lib/translations';

export const NatureCaptchaUI = ({
  isVerified,
  onVerify,
  isRtl,
  t,
}: {
  isVerified: boolean;
  onVerify: () => void;
  isRtl: boolean;
  t: AuthTranslations;
}) => {
  const sliderRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  // The server burns a challenge on first `/verify` (single-use), so a second
  // verify for the same slide is rejected and drops the widget back to
  // unverified — which reads as the thumb snapping to the start exactly when
  // the slide finishes. `checking` cannot prevent that: it is React state, so
  // a pointermove that crosses the threshold and the pointerup right behind it
  // both still see it false. Only a ref updates synchronously enough to gate
  // the two events against each other.
  const completedRef = useRef(isVerified);
  // Seeded from `isVerified`, not 0: the pass lives in the parent hook, which
  // outlives this widget when a multi-step form unmounts step 1 (e.g. going to
  // the OTP step and back). Starting at 0 would remount the thumb at the start
  // while the label still says verified.
  const [sliderValue, setSliderValue] = useState(isVerified ? 100 : 0);
  // `onVerify` now round-trips to the server (F-0201) — the slide is complete
  // before `isVerified` (a prop) has any chance to flip. Without this, the
  // pointer-up handler fires first, sees `isVerified` still false, and snaps
  // the thumb straight back to the start every time.
  const [pending, setPending] = useState(false);
  const checking = isVerified || pending;

  // Keep the thumb in sync with the pass the parent holds, in both
  // directions: full while verified (a remount inside a still-valid pass), and
  // back to the start when the parent flips isVerified to false because the
  // server-issued pass expired (every 120s), so the widget visibly asks to be
  // re-verified instead of showing a stale full bar. Skip the reset while a
  // verify call is still in flight (`pending`), or it would reset mid-check.
  useEffect(() => {
    if (isVerified) {
      completedRef.current = true;
      // deliberate prop→state sync: the thumb position mirrors a pass owned by
      // the parent hook (see the comment above), not derivable during render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSliderValue(100);
      return;
    }
    if (!pending) {
      completedRef.current = false;
      setSliderValue(0);
    }
  }, [isVerified, pending]);

  const percentFromEvent = (e: { clientX: number }) => {
    const slider = sliderRef.current;
    if (!slider) return null;

    const rect = slider.getBoundingClientRect();

    let newValue = 0;
    if (isRtl) {
      newValue = Math.min(
        Math.max(0, rect.right - e.clientX),
        rect.width - 44
      );
    } else {
      newValue = Math.min(
        Math.max(0, e.clientX - rect.left),
        rect.width - 44
      );
    }

    return (newValue / (rect.width - 44)) * 100;
  };

  const complete = () => {
    if (completedRef.current) return;
    completedRef.current = true;
    setSliderValue(100);
    setPending(true);
    Promise.resolve(onVerify()).finally(() => setPending(false));
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (completedRef.current || checking) return;
    if (e.buttons !== 1) return;

    const percent = percentFromEvent(e);
    if (percent === null) return;
    setSliderValue(percent);

    if (percent > 95) complete();
  };

  // A fast drag can release the pointer between two `pointermove` events, so
  // the last recorded `sliderValue` may still read under 95% even though the
  // thumb visually reached the end — check the release position itself
  // instead of trusting the last move event, or the thumb snaps back to
  // start right as the user finishes the gesture.
  //
  // Both `onPointerUp` and `onPointerLeave` call this, and `onPointerLeave`
  // fires on plain hover with no button held (e.g. cursor grazing the edge,
  // or the native pointerleave that follows pointerup once capture is
  // released) — `draggingRef` is the only reliable way to tell "a drag just
  // ended" from "the cursor merely passed over/off the widget". Without it,
  // hovering near the end with no click at all could trigger a verify, and a
  // pointerup immediately followed by pointerleave could fire this twice.
  const resetSlider = (e: React.PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;

    if (completedRef.current || checking) return;

    const percent = percentFromEvent(e);
    if (percent !== null && percent > 95) {
      complete();
      return;
    }

    setSliderValue(0);
  };

  return (
    <div
      ref={sliderRef}
      onPointerDown={(e) => {
        if (completedRef.current || checking) return;
        draggingRef.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={handlePointerMove}
      onPointerUp={resetSlider}
      onPointerLeave={resetSlider}
      className={`relative w-full h-[54px] rounded-[27px] border-[1.5px] transition-all duration-300 overflow-hidden select-none touch-none ${
        checking
          ? "border-primary bg-primary/10"
          : "border-card-border bg-bg-inner"
      }`}
    >
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          className={`absolute start-0 top-0 bottom-0 transition-all duration-100 ${checking ? 'bg-primary/20' : 'bg-gradient-to-r from-primary/10 to-primary/40'}`}
          style={{ width: `${sliderValue}%` }}
        />
        <span
          className={`absolute text-[13px] z-10 transition-colors duration-300 ${
            checking
              ? "text-primary font-bold"
              : "text-text-secondary"
          }`}
        >
          {isVerified ? t.captchaVerified : pending ? t.captchaChecking : t.captchaSwipe}
        </span>
      </div>
      <div
        className={`absolute top-[4px] bottom-[4px] w-[44px] h-[44px] rounded-full shadow-md flex items-center justify-center cursor-grab active:cursor-grabbing z-20 transition-all duration-100 ${
          checking ? "border border-primary text-primary bg-card-bg" : "bg-card-bg text-text-secondary border border-card-border dark:border-white/10"
        }`}
        style={{
          insetInlineStart: `calc(${sliderValue}% - ${
            sliderValue > 0 ? (sliderValue / 100) * 44 : 0
          }px)`,
        }}
      >
        {checking ? (
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <ChevronRight size={20} className={isRtl ? "rotate-180" : ""} />
        )}
      </div>
    </div>
  );
};
