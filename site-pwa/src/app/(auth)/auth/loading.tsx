/**
 * اسکلتِ فرمِ auth — تا وقتی باندلِ روت دانلود/هایدریت شود این نمایش داده
 * می‌شود، پس جای فرم خالی نمی‌ماند. عمداً بدون framer-motion / lucide است تا
 * خودش چیزی به باندل اضافه نکند و فوری بیاید. شکلِ کلی‌اش با
 * login/signup/forgot یکی است (هدر، تب‌بار، دو فیلد، کپچا، دکمه).
 */
export default function AuthLoading() {
  return (
    <div className="w-full animate-pulse" aria-hidden>
      {/* هدر */}
      <div className="text-center mb-8 w-full flex flex-col items-center">
        <div className="h-8 w-40 rounded-lg bg-card-border/60 mb-3" />
        <div className="h-4 w-56 rounded bg-card-border/40" />
      </div>

      {/* تب‌بار */}
      <div className="flex bg-tab-bg rounded-2xl p-1.5 mb-8 border border-card-border shadow-inner gap-1.5">
        <div className="flex-1 h-10 rounded-xl bg-card-border/40" />
        <div className="flex-1 h-10 rounded-xl bg-transparent" />
      </div>

      {/* فیلدها */}
      <div className="space-y-6 min-h-[150px]">
        <div className="h-14 w-full rounded-2xl border border-card-border bg-bg-inner" />
        <div className="h-14 w-full rounded-2xl border border-card-border bg-bg-inner" />
      </div>

      {/* کپچا */}
      <div className="mt-4 mb-4 h-[54px] w-full rounded-[27px] border-[1.5px] border-card-border bg-bg-inner" />

      {/* دکمه */}
      <div className="h-12 w-full rounded-2xl bg-primary/30" />
    </div>
  );
}
