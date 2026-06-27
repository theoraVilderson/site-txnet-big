"use client";
import { useEffect, useRef, useState } from "react";
import { CaptchaTokenType, CaptchaValidateData } from "./NatureCaptcha";
import { apiReq } from "@/lib/request"; 

export function NatureCaptchaAction({
  onVerify,
  token = null,
}: {
  token: CaptchaTokenType | null;
  onVerify: (data: CaptchaValidateData) => void;
}) {
  const [isLocked, setIsLocked] = useState(true);
  const [sliderValue, setSliderValue] = useState(0);
  const [startTime, setStartTime] = useState<number>(0); // ثبت زمان شروع درگ
  const sliderRef = useRef<HTMLDivElement>(null);
  const [activePointer, setActivePointer] = useState(null);

  const handelPointerDown = (e: any) => {
    if (activePointer === null) {
      setActivePointer(e.pointerId);
      setStartTime(Date.now()); // وقتی کاربر کلیک کرد، تایمر روشن می‌شود
    }
  };

  const handlePointerMove = async (e: any) => {
    if (!isLocked) return;
    if (e.buttons !== 1) return; 

    const slider = sliderRef.current;
    if (!slider) return;

    const rect = slider.getBoundingClientRect();
    const clientX = e.clientX;
    const newValue = Math.min(
      Math.max(0, clientX - rect.left),
      rect.width - 50 
    );

    const percent = (newValue / (rect.width - 50)) * 100;
    setSliderValue(percent);

    if (percent > 95) {
      setIsLocked(false);
      setSliderValue(100);
      
      const dragTime = Date.now() - startTime; // محاسبه زمان صرف شده توسط کاربر

      try {
        // ارسال رفتار کاربر به سرور برای دریافت توکن امنیتی
        const res = await apiReq.post("/captcha/solve", {
          captchaToken: token?.token,
          dragTime: dragTime
        });

        // دریافت توکن وریفای امن از سرور
        onVerify({
          captchaToken: token?.token!,
          verifyToken: res.data.data.verifyToken,
        });

      } catch (err) {
        // در صورت تشخیص ربات، اسلایدر به حالت اول برمی‌گردد
        resetSlider(null, true);
        setIsLocked(true);
      }
    }
  };

  const resetSlider = (e: any, justReset = false) => {
    if (isLocked || justReset) setSliderValue(0);
    if (justReset) return;

    if (e?.pointerId === activePointer) {
      setActivePointer(null);
    }
  };

  useEffect(() => {
    resetSlider(null, true);
    if (token) onVerify(null as any);
  }, [token]);

  return (
    <div
      className={`nature-captcha ${!isLocked ? "verified" : ""}`}
      ref={sliderRef}
      onPointerDown={handelPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={resetSlider}
      onPointerLeave={resetSlider}
    >
       {/* HTML قبلی بدون تغییر است */}
      <div className="captcha-track">
        <div className="captcha-fill" style={{ width: `${sliderValue}%` }}></div>
        <div className="captcha-text">
          {isLocked ? "برای تایید، برگ را بکشید" : "تایید شد"}
        </div>
      </div>
      <div className="captcha-handle" style={{ left: `calc(${sliderValue}% - ${sliderValue > 0 ? 0 : 0}px)` }}>
        {isLocked ? (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 18l6-6-6-6" />
          </svg>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#2e7d32" strokeWidth="2">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </div>
    </div>
  );
}