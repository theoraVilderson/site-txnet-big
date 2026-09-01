import React, { useRef, useState } from 'react';

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

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement>,
    index: number
  ) => {
    const val = e.target.value;
    if (!/^[0-9]*$/.test(val)) return;

    const newVal = value.split("");
    newVal[index] = val.substring(val.length - 1);
    const combined = newVal.join("");
    onChange(combined);

    if (val) {
      setPopIndex(index);
      setTimeout(() => setPopIndex(null), 200);
      if (index < length - 1) inputs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    index: number
  ) => {
    if (e.key === "Backspace" && !value[index] && index > 0) {
      inputs.current[index - 1]?.focus();
    }
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
            maxLength={1}
            value={value[i] || ""}
            onChange={(e) => handleChange(e, i)}
            onKeyDown={(e) => handleKeyDown(e, i)}
            className={`w-12 h-14 sm:w-14 sm:h-16 text-center text-2xl font-bold bg-bg-inner border border-card-border text-text-primary rounded-xl focus:outline-none focus:border-primary transition-all shadow-sm duration-200 ${
              popIndex === i ? "scale-110 border-primary" : "scale-100"
            }`}
          />
        ))}
      </div>
    </div>
  );
};
