/**
 * A thrown value as one log line. A Prisma error's message opens with a blank
 * line and names the cause lines below, so `failed: ${e.message}` read as
 * `failed: ` with nothing after it wherever the log is read a line at a time.
 */
export function errorLine(e: unknown): string {
  const text = (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim();
  return text || `${e instanceof Error ? e.name : typeof e} (no message)`;
}
