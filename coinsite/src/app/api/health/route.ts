// The container's healthcheck (hosting H24): does this Next server answer.
// Static, so it is built once and a check every 10s renders nothing; it asks
// no session, tenant or upstream, whose failures belong to their own checks.
export const dynamic = "force-static";

/** 200 `ok` while the server is up. */
export function GET(): Response {
  return new Response("ok");
}
