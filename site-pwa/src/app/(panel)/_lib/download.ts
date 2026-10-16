/**
 * Hand the browser a file (F-502-h's gift codes, F-1007-b's analytics export).
 * Nothing touches storage or a URL that outlives the click: the object URL is
 * revoked at once.
 */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** A file built from text — a BOM first, so a spreadsheet opens the CSV as UTF-8. */
export function downloadText(filename: string, text: string, type = "text/csv;charset=utf-8"): void {
  downloadBlob(filename, new Blob(["\uFEFF", text], { type }));
}
