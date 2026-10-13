import { PREFERS_DARK_QUERY } from "@/lib/theme";

/**
 * Acts only when the server could not settle the theme (no account value, no
 * cookie): it runs synchronously in <head> before the body paints, so the
 * "system" choice lands on <html> with no flash.
 */
export const THEME_SCRIPT = `
(function () {
  try {
    var html = document.documentElement;
    if (html.hasAttribute('data-theme-resolved')) return;
    var prefersDark = window.matchMedia && window.matchMedia('${PREFERS_DARK_QUERY}').matches;
    var resolved = prefersDark ? 'dark' : 'light';
    html.setAttribute('data-theme', resolved);
    html.classList.toggle('dark', resolved === 'dark');
  } catch (e) {}
})();
`;
