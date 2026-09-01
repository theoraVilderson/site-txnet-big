"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Eye, EyeOff } from "lucide-react";

interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  showLabel: string;
  hideLabel: string;
  error?: string;
  autoComplete?: string;
}

const CHAR_STAGGER = 0.035;
const ANIM_DURATION = 0.45;

const rollVariants = {
  hidden: (isRevealing: boolean) => ({
    opacity: 0,
    rotateX: isRevealing ? -90 : 90,
    y: isRevealing ? -12 : 12,
    filter: "blur(3px)",
  }),
  visible: {
    opacity: 1,
    rotateX: 0,
    y: 0,
    filter: "blur(0px)",
  },
  exit: (isRevealing: boolean) => ({
    opacity: 0,
    rotateX: isRevealing ? 90 : -90,
    y: isRevealing ? 12 : -12,
    filter: "blur(3px)",
  }),
};

export function PasswordField({
  id,
  label,
  value,
  onChange,
  showLabel,
  hideLabel,
  error,
  autoComplete = "new-password",
}: PasswordFieldProps) {
  const [showText, setShowText] = useState(false);
  const [focused, setFocused] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const floated = focused || value.length > 0;

  useEffect(() => () => clearTimeout(timeoutRef.current), []);

  // اگه کاربر همه متن رو پاک کرد، حالت نمایش پسورد رو ریست کن
  useEffect(() => {
    if (value.length === 0) setShowText(false);
  }, [value]);

  const toggleVisibility = () => {
    if (value.length === 0) {
      setShowText((v) => !v);
      return;
    }

    setIsAnimating(true);
    setShowText((v) => !v);

    clearTimeout(timeoutRef.current);

    const maxStagger = Math.min(value.length, 25);
    const totalMs = (ANIM_DURATION + maxStagger * CHAR_STAGGER) * 1000 + 50;

    timeoutRef.current = setTimeout(() => {
      setIsAnimating(false);
    }, totalMs);
  };

  return (
    <div className="relative mb-5">
      {/* Container اصلی: dir="ltr" را حذف کردیم تا با توجه به HTML (RTL/LTR) تنظیم شود */}
      <div
        className={`relative rounded-2xl bg-bg-inner border-[1.5px] transition-colors duration-300 ${
          error
            ? "border-error shadow-[0_0_0_2px_var(--error-bg)]"
            : focused || isAnimating
              ? "border-primary shadow-[0_0_0_2px_var(--accent-glow)]"
              : "border-card-border hover:border-text-secondary"
        }`}
      >
        {/* Label:
            از start-5 استفاده می‌کند تا در فارسی سمت راست و در انگلیسی چپ باشد.
            rtl:origin-right باعث می‌شود در فارسی موقع کوچک شدن به درستی به سمت راست جمع شود.
        */}
        <motion.label
          htmlFor={id}
          initial={false}
          animate={
            floated
              ? { top: "0", y: "-50%", scale: 0.85 }
              : { top: "50%", y: "-50%", scale: 1 }
          }
          transition={{ duration: 0.2, ease: "easeOut" }}
          className={`absolute start-5 rtl:origin-right ltr:origin-left pointer-events-none z-10 px-1.5 rounded bg-bg-inner transition-colors duration-300 ${
            floated ? "text-primary font-bold" : "text-[var(--text-label)]"
          }`}
        >
          {label}
        </motion.label>

        {/* فیلد اصلی:
            دارای dir="ltr" است. به جای ps/pe از پدینگ فیزیکی pl-5 و pr-12 استفاده کردیم
            تا در هر زبانی تایپ از چپ شروع شود و جای دکمه چشم در راست حفظ شود.
        */}
        <input
          id={id}
          name={id}
          type={showText ? "text" : "password"}
          dir="ltr"
          autoComplete={autoComplete}
          value={value}
          onChange={onChange}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          aria-invalid={!!error}
          className={`w-full bg-transparent border-none rounded-2xl outline-none pt-5 pb-3 pl-5 pr-12 font-mono tracking-widest text-base text-[var(--text-input)] text-left z-20 relative ${
            isAnimating ? "opacity-0" : "opacity-100"
          }`}
          style={{ transition: "none" }}
        />

        {/* لایه انیمیشن: 
            اینجا هم از dir="ltr" و pl-5 pr-12 استفاده شده تا کاملاً روی فیلد اصلی مچ شود.
        */}
        {isAnimating && (
          <div
            aria-hidden
            dir="ltr"
            className="absolute inset-0 pt-5 pb-3 pl-5 pr-12 flex items-center pointer-events-none z-30 font-mono tracking-widest text-base text-left"
          >
            <div
              className="flex h-full items-center"
              style={{ perspective: 1000 }}
            >
              {value.split("").map((char, i) => (
                <span
                  key={i}
                  className="relative inline-flex items-center justify-center"
                  style={{ width: "1.2ch", height: "1.5em" }}
                >
                  <AnimatePresence mode="popLayout" custom={showText}>
                    {showText ? (
                      <motion.span
                        key="text"
                        custom={showText}
                        variants={rollVariants}
                        initial="hidden"
                        animate="visible"
                        exit="exit"
                        transition={{
                          duration: ANIM_DURATION,
                          delay: Math.min(i, 25) * CHAR_STAGGER,
                          ease: "backOut",
                        }}
                        className="absolute text-[var(--text-input)]"
                      >
                        {char}
                      </motion.span>
                    ) : (
                      <motion.span
                        key="mask"
                        custom={showText}
                        variants={rollVariants}
                        initial="hidden"
                        animate="visible"
                        exit="exit"
                        transition={{
                          duration: ANIM_DURATION,
                          delay: Math.min(i, 25) * CHAR_STAGGER,
                          ease: "backOut",
                        }}
                        className="absolute text-[var(--text-input)]"
                      >
                        •
                      </motion.span>
                    )}
                  </AnimatePresence>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* دکمه چشمک‌زن: فقط وقتی متنی نوشته شده باشه ظاهر میشه */}
        {value.length > 0 && (
          <motion.button
            type="button"
            onClick={toggleVisibility}
            whileTap={{ scale: 0.85 }}
            aria-label={showText ? hideLabel : showLabel}
            aria-pressed={showText}
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.5 }}
            className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center justify-center w-9 h-9 text-text-secondary hover:text-primary hover:bg-leaf-bg transition-colors z-40 rounded-full"
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={showText ? "visible" : "hidden"}
                initial={{ opacity: 0, scale: 0.5, rotate: -45 }}
                animate={{ opacity: 1, scale: 1, rotate: 0 }}
                exit={{ opacity: 0, scale: 0.5, rotate: 45 }}
                transition={{ duration: 0.2, ease: "easeOut" }}
              >
                {showText ? <EyeOff size={19} /> : <Eye size={19} />}
              </motion.span>
            </AnimatePresence>
          </motion.button>
        )}
      </div>

      {error && (
        <motion.p
          initial={{ opacity: 0, y: -5 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-1.5 ms-2 text-xs text-error font-medium"
        >
          {error}
        </motion.p>
      )}
    </div>
  );
}
