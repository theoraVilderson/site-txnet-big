/**
 * فقط وقتی سرور نتونسته تم رو قطعی تعیین کنه (نه اکانت، نه کوکی) کاری می‌کنه.
 * در اون حالت هم چون این اسکریپت synchronous توی <head> و قبل از رندر body
 * اجرا می‌شه، هیچ فلاشی دیده نمی‌شه — با matchMedia بلافاصله تم درست رو
 * روی <html> ست می‌کنه، قبل از اینکه مرورگر چیزی پینت کنه.
 */
export const THEME_SCRIPT = `
(function () {
  try {
    var html = document.documentElement;
    if (html.hasAttribute('data-theme-resolved')) return;
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var resolved = prefersDark ? 'dark' : 'light';
    html.setAttribute('data-theme', resolved);
    html.classList.toggle('dark', resolved === 'dark');
  } catch (e) {}
})();
`;
