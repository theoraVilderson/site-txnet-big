import React, { useEffect, useRef, useState } from 'react';
import { toEnglishDigits } from '@/util/helper';

/** The ASCII digits in what was typed or pasted: a Persian keyboard or SMS writes ۵۴۳. */
const digitsOf = (text: string) => toEnglishDigits(text).replace(/\D/g, '');

/**
 * One box per digit. Typing or pasting the last digit submits the form the
 * boxes are in — once, after the parent has rendered the full code, so its
 * submit handler reads that code and not the one before it.
 */

export const OTPInput = ({
  length = 5,
  value,
  onChange,
}: {
  length?: number;
  value: string;
  onChange: (val: string) => void;
}) => {
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const [popIndex, setPopIndex] = useState<number | null>(null);

  // Set by a change that completes the code; spent by the effect below.
  const submitWhenFull = useRef(false);

  useEffect(() => {
    if (!submitWhenFull.current || value.length !== length) return;
    submitWhenFull.current = false;
    inputs.current[0]?.form?.requestSubmit();
  }, [value, length]);

  /** Writes `digits` from box `from` on, moves focus past them, and arms the submit when full. */
  const write = (digits: string, from: number) => {
    const chars = value.split('');
    for (let i = 0; i < digits.length && from + i < length; i++) chars[from + i] = digits[i];
    const combined = chars.join('').slice(0, length);
    // Only a change that completes the code, or writes all of it at once:
    // typing over a code that was already full is still being corrected.
    if (combined.length === length && (value.length < length || digits.length >= length)) submitWhenFull.current = true;
    onChange(combined);
    inputs.current[Math.min(from + digits.length, length - 1)]?.focus();
  };

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement>,
    index: number
  ) => {
    const raw = e.target.value;
    const digits = digitsOf(raw);
    if (!raw) {
      const chars = value.split('');
      chars[index] = '';
      onChange(chars.join(''));
      return;
    }
    if (!digits) return;

    // The OS's one-time-code autofill writes the whole code into one box;
    // a typed key over a filled box arrives as two characters, the new last.
    if (digits.length >= length) return write(digits.slice(0, length), 0);
    if (digits.length > 2) return write(digits, index);
    write(digits.slice(-1), index);
    setPopIndex(index);
    setTimeout(() => setPopIndex(null), 200);
  };

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    index: number
  ) => {
    if (e.key === "Backspace" && !value[index] && index > 0) {
      inputs.current[index - 1]?.focus();
    }
  };

  // SMS autofill (WebOTP on Android, autocomplete="one-time-code" on iOS
  // Safari) delivers the whole code as one paste into whichever box has
  // focus — since the code is split across `length` single-char boxes, that
  // paste has to be redistributed by hand or autofill only ever fills box 0.
  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>, index: number) => {
    const pasted = digitsOf(e.clipboardData.getData("text"));
    if (!pasted) return;
    e.preventDefault();
    // A whole code starts at the first box wherever it was pasted.
    write(pasted.slice(0, length), pasted.length >= length ? 0 : index);
  };

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="flex justify-center gap-2 sm:gap-3 dir-ltr" dir="ltr">
        {Array.from({ length }).map((_, i) => (
          <input
            key={i}
            ref={(el) => {
              inputs.current[i] = el;
            }}
            type="text"
            inputMode="numeric"
            autoComplete={i === 0 ? "one-time-code" : "off"}
            value={value[i] || ""}
            onChange={(e) => handleChange(e, i)}
            onKeyDown={(e) => handleKeyDown(e, i)}
            onPaste={(e) => handlePaste(e, i)}
            className={`w-12 h-14 sm:w-14 sm:h-16 text-center text-2xl font-bold bg-bg-inner border border-card-border text-text-primary rounded-xl focus:outline-none focus:border-primary transition-all shadow-sm duration-200 ${
              popIndex === i ? "scale-110 border-primary" : "scale-100"
            }`}
          />
        ))}
      </div>
    </div>
  );
};
