import React, { useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';

export const NatureCaptchaUI = ({
  isVerified,
  onVerify,
  isRtl,
  t,
}: {
  isVerified: boolean;
  onVerify: () => void;
  isRtl: boolean;
  t: any;
}) => {
  const sliderRef = useRef<HTMLDivElement>(null);
  const [sliderValue, setSliderValue] = useState(0);

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isVerified) return;
    if (e.buttons !== 1) return;

    const slider = sliderRef.current;
    if (!slider) return;

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

    const percent = (newValue / (rect.width - 44)) * 100;
    setSliderValue(percent);

    if (percent > 95) {
      setSliderValue(100);
      onVerify();
    }
  };

  const resetSlider = () => {
    if (!isVerified) setSliderValue(0);
  };

  return (
    <div
      ref={sliderRef}
      onPointerDown={(e) => (e.currentTarget.setPointerCapture(e.pointerId))}
      onPointerMove={handlePointerMove}
      onPointerUp={resetSlider}
      onPointerLeave={resetSlider}
      className={`relative w-full h-[54px] rounded-[27px] border-[1.5px] transition-all duration-300 overflow-hidden select-none touch-none ${
        isVerified
          ? "border-primary bg-primary/10"
          : "border-card-border bg-bg-inner"
      }`}
    >
      <div className="absolute inset-0 flex items-center justify-center">
        <div
          className={`absolute start-0 top-0 bottom-0 transition-all duration-100 ${isVerified ? 'bg-primary/20' : 'bg-gradient-to-r from-primary/10 to-primary/40'}`}
          style={{ width: `${sliderValue}%` }}
        />
        <span
          className={`absolute text-[13px] z-10 transition-colors duration-300 ${
            isVerified
              ? "text-primary font-bold"
              : "text-text-secondary"
          }`}
        >
          {isVerified ? t.captchaVerified : t.captchaSwipe}
        </span>
      </div>
      <div
        className={`absolute top-[4px] bottom-[4px] w-[44px] h-[44px] rounded-full shadow-md flex items-center justify-center cursor-grab active:cursor-grabbing z-20 transition-all duration-100 ${
          isVerified ? "border border-primary text-primary bg-card-bg" : "bg-card-bg text-text-secondary border border-card-border dark:border-white/10"
        }`}
        style={{
          insetInlineStart: `calc(${sliderValue}% - ${
            sliderValue > 0 ? (sliderValue / 100) * 44 : 0
          }px)`,
        }}
      >
        {isVerified ? (
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
