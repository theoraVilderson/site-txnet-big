import { useEffect, useState } from "react";

export function useOtpTimer(initialSeconds = 0) {
  const [seconds, setSeconds] = useState(initialSeconds);

  useEffect(() => {
    if (seconds <= 0) return;
    const interval = setInterval(() => setSeconds((p) => p - 1), 1000);
    return () => clearInterval(interval);
  }, [seconds]);

  const start = (duration = 120) => setSeconds(duration);

  const formatted = (() => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  })();

  return { seconds, start, formatted, isRunning: seconds > 0 };
}
