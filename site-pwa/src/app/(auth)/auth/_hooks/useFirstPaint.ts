"use client";

import { useEffect, useRef } from "react";

/**
 * روی *اولین* رندرِ کلاینت در طول عمر همین تبِ مرورگر `true` برمی‌گرداند و
 * بعد از آن همیشه `false`.
 *
 * کاربرد: انیمیشن‌های ورودِ framer-motion که از `opacity:0` شروع می‌شوند،
 * محتوای SSR را تا پایانِ hydration + اجرای انیمیشن نامرئی نگه می‌دارند. با
 * `initial={useFirstPaint() ? false : {...}}` فقط روی لودِ اولِ صفحه انیمیشن
 * رد می‌شود (محتوا فوری دیده می‌شود) ولی ناوبری سمت کلاینت که بعد از
 * hydration رخ می‌دهد همچنان انیمیشن دارد.
 *
 * چون فلگ ماژول‌سطح است و فقط داخل effect ست می‌شود، در یک رندر همه‌ی
 * صداکننده‌ها مقدار یکسان می‌گیرند.
 */
let paintedOnce = false;

export function useFirstPaint(): boolean {
  const first = useRef(!paintedOnce);
  useEffect(() => {
    paintedOnce = true;
  }, []);
  return first.current;
}
