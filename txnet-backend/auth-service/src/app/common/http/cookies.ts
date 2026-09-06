/**
 * Reading a cookie off the raw request header.
 *
 * auth-service does not install `cookie-parser`, and deliberately: it reads
 * exactly two cookies (`refresh_token`, `device_id`), both on paths that
 * already have the `Request` in hand. A global parser would add a middleware
 * and a dependency to save this function.
 */
export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  const value = header
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return value ? decodeURIComponent(value.slice(name.length + 1)) : undefined;
}
