// The channel names the panel subscribes to. The gateway decides who may have
// a channel by matching this string (`platform/realtime/contract.channels.md`),
// so each family is spelled once, here (C-04).

/**
 * The channel that carries one signed-in user's own events
 * (`realtime/contract.channels.md`: `user:<userId>`, served to that user and
 * nobody else, and no permission grants another person's).
 *
 * Spelled here rather than at each subscriber, for the reason C-04 gives about
 * a boundary-crossing name: the gateway decides who may have this channel by
 * matching the string, and a second spelling is refused as
 * `realtime.channelForbidden` — a refusal with no status code a browser can
 * see. F-093-c is the first subscriber; it will not be the last.
 */
export function userChannel(userId: string): string {
  return `user:${userId}`;
}

/**
 * A reseller-wide channel (F-027-bs). The gateway grants it only with
 * `realtime.tenant.read` *and* an exact tenant match
 * (`platform/realtime/contract.channels.md`), so the id is the caller's own.
 */
export function tenantChannel(tenantId: string): string {
  return `tenant:${tenantId}`;
}

/**
 * Every signed-in member of a tenant (RT-1-k). No permission, only an exact
 * tenant match (`platform/realtime/contract.channels.md`), so it is the
 * session's own tenant id.
 */
export function membersChannel(tenantId: string): string {
  return `members:${tenantId}`;
}
