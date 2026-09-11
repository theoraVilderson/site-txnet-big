/**
 * Copy text to the clipboard (F-093-b) — a reference number, a gift code.
 * Resolves `false` rather than throwing when the browser refuses, so the
 * caller decides whether that is worth a toast.
 *
 * `navigator.clipboard` exists only in a secure context; the textarea path is
 * for the rest (a plain-http dev host, an old in-app browser). Legacy used
 * only that path and could not tell success from failure.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the textarea path
    }
  }
  if (typeof document === "undefined") return false;

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(textarea);
  }
}
