/**
 * روی بالا آمدنِ سرور Next یک‌بار اجرا می‌شود (Node runtime).
 *
 * اینجا کلاینت gRPC زبان را بوت می‌کنیم تا:
 *  - کل زبان‌ها *یک‌بار* گرفته شوند و در حافظه‌ی همین پروسه بمانند،
 *  - استریم Watch باز شود تا آپدیت‌ها خودشان از locale-service بیایند،
 *  - هزینه‌ی بوت روی «اولین درخواستِ کاربر» نیفتد (علتِ دیر آمدنِ زبان
 *    در پنل بعد از هر ری‌استارت).
 *
 * اگر بوت اینجا شکست بخورد صرفاً لاگ می‌شود؛ `ensureReady` روی مسیر درخواست
 * دوباره تلاش می‌کند و تا آن موقع رندر با fallback ادامه پیدا می‌کند.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { initStore } = await import("@/lib/locale-store");
  const { startWatching } = await import("@/lib/locale-watcher");

  try {
    await initStore();
    await startWatching();
    console.log("[locale] warmed at server boot");
  } catch (e) {
    console.error(
      "[locale] boot warm-up failed — will retry on first request",
      e,
    );
  }
}
