/** One anchor, clicked and gone: the browser saves `href` as `filename` (empty: the server's name). */
function saveAs(href: string, filename: string): void {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Hand the browser a file (F-502-h's gift codes, F-1007-b's analytics export).
 * Nothing touches storage or a URL that outlives the click: the object URL is
 * revoked at once.
 */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  saveAs(url, filename);
  URL.revokeObjectURL(url);
}

/** A file built from text — a BOM first, so a spreadsheet opens the CSV as UTF-8. */
export function downloadText(filename: string, text: string, type = "text/csv;charset=utf-8"): void {
  downloadBlob(filename, new Blob(["﻿", text], { type }));
}

/**
 * Hand the browser a file the server serves (F-212-c's archive, a signed
 * same-host path) without navigating the panel away. A URL that expires is
 * used once, on the click that minted it.
 */
export function downloadUrl(url: string): void {
  saveAs(url, "");
}
