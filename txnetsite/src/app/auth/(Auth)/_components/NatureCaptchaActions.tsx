"use client";
import { useEffect, useRef, useState } from "react";
import { _0x, CaptchaTokenType, CaptchaValidateData } from "./NatureCaptcha";

export function NatureCaptchaAction({
  onVerify,
  token = null,
}: {
  token: CaptchaTokenType | null;
  onVerify: (data: CaptchaValidateData) => void;
}) {
  const [isLocked, setIsLocked] = useState(true);
  const [sliderValue, setSliderValue] = useState(0);
  const sliderRef = useRef<HTMLDivElement>(null);
  const [activePointer, setActivePointer] = useState(null);
  const handlePointerMove = (e: any) => {
    if (!isLocked) return;
    if (e.buttons !== 1) return; // فقط وقتی کلیک نگه داشته شده

    const slider = sliderRef.current;
    if (!slider) return;

    const rect = slider.getBoundingClientRect();
    const clientX = e.clientX;
    const newValue = Math.min(
      Math.max(0, clientX - rect.left),
      rect.width - 50 // عرض هندل
    );

    const percent = (newValue / (rect.width - 50)) * 100;
    setSliderValue(percent);

    if (percent > 95) {
      setIsLocked(false);
      onVerify({
        captchaToken: token?.token!,
        verifyToken: _0x(
          JSON.stringify({
            ip: token?.value.ip,
            jti: token?.value.jti,
          }),
          token?.token!
        ),
      });
      setSliderValue(100);
    }
  };

  const resetSlider = (e: any, justReset = false) => {
    if (isLocked || justReset) setSliderValue(0);
    if (justReset) return;

    if (e.pointerId === activePointer) {
      setActivePointer(null);
    }
  };
  useEffect(() => {
    resetSlider(null, true);
    if (token) {
      onVerify(null);
    }
  }, [token]);
  const handelPointerDown = (e: any) => {
    if (activePointer === null) {
      setActivePointer(e.pointerId);

      console.log("start:", e.clientX, e.clientY);
    }
  };
  return (
    <div
      className={`nature-captcha ${!isLocked ? "verified" : ""}`}
      ref={sliderRef}
      onPointerDown={handelPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={resetSlider}
      onPointerLeave={resetSlider}
    >
      <div className="captcha-track">
        <div
          className="captcha-fill"
          style={{ width: `${sliderValue}%` }}
        ></div>
        <div className="captcha-text">
          {isLocked ? "برای تایید، برگ را بکشید" : "تایید شد"}
        </div>
      </div>
      <div
        className="captcha-handle"
        style={{ left: `calc(${sliderValue}% - ${sliderValue > 0 ? 0 : 0}px)` }}
      >
        {isLocked ? (
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M9 18l6-6-6-6" />
          </svg>
        ) : (
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#2e7d32"
            strokeWidth="2"
          >
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </div>
    </div>
  );
}
