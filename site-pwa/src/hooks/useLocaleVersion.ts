import { useEffect, useRef, useState } from 'react';

/**
 * سمت کلاینت هر intervalMs یه بار /api/i18n/version رو چک می‌کنه.
 * اگه نسخه عوض شده باشه، stale=true می‌شه تا مثلاً یه بنر "نسخه جدید موجوده" نشون بدی.
 */
export function useLocaleVersion(intervalMs = 5 * 60 * 1000) {
  const [version, setVersion] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const currentVersionRef = useRef<string | null>(null);

  useEffect(() => {
    async function check() {
      const res = await fetch('/api/i18n/version');
      const { version: newVersion } = await res.json();

      if (currentVersionRef.current === null) {
        currentVersionRef.current = newVersion;
        setVersion(newVersion);
        return;
      }

      if (newVersion !== currentVersionRef.current) {
        setStale(true);
      }
    }

    check();
    const interval = setInterval(check, intervalMs);
    return () => clearInterval(interval);
  }, [intervalMs]);

  return { version, stale };
}
