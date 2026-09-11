"use client";

import { useCallback, useEffect, useState } from "react";
import {
  authApi,
  type OtpDeliveryHandles,
  type OtpDeliveryStatus,
} from "@/lib/auth-api";
import { createRealtimeClient } from "@/lib/realtime";

/**
 * Says what became of the code an auth screen just asked for (F-070-b).
 *
 * Two sources answer the same question and either may be first. The push on
 * `otp:<channelId>` is the fast one and is at-most-once — it is dropped when
 * nobody is listening (`realtime/contract.fanout.md`) — while
 * `POST /auth/otp/delivery/status` is the record D-15 keeps, read once for a
 * screen whose socket never opened or that connected past the event.
 *
 * The socket is anonymous: these four routes have no session by definition, so
 * the channel is authorized by the token the 202 handed over, not by who is
 * asking (ADR-0031).
 *
 * **`queued` means *not yet*, never *no such number*.** The handles are minted
 * before the route knows whether there is an account behind the phone number,
 * which is exactly what stops a 202 from answering that question — so a
 * delivery that never leaves `queued` is indistinguishable from a slow
 * provider, and it is rendered as one.
 */
export type OtpDelivery = OtpDeliveryStatus;

/** `queued` is the state the 202 already told us about; it is never published. */
function endState(payload: unknown): OtpDelivery | null {
  if (!payload || typeof payload !== "object") return null;
  const { state, failureKey } = payload as { state?: unknown; failureKey?: unknown };
  if (state !== "sent" && state !== "failed") return null;
  return typeof failureKey === "string" ? { state, failureKey } : { state };
}

export function useOtpDelivery() {
  const [handles, setHandles] = useState<OtpDeliveryHandles | null>(null);
  const [delivery, setDelivery] = useState<OtpDelivery | null>(null);

  /** Called with the handles a 202 answered with — one delivery, one call. */
  const start = useCallback((next: OtpDeliveryHandles) => {
    setDelivery({ state: "queued" });
    setHandles(next);
  }, []);

  const reset = useCallback(() => {
    setHandles(null);
    setDelivery(null);
  }, []);

  useEffect(() => {
    if (!handles) return;
    let alive = true;

    // Only an end state may replace what is held. The status route can answer
    // `queued` after the socket has already delivered `sent`, and a screen
    // that went back to waiting would be showing the older of two answers.
    const settle = (next: OtpDelivery | null) => {
      if (alive && next) setDelivery(next);
    };

    const client = createRealtimeClient();
    const leave = client.subscribe(handles.channel, {
      proof: handles.channelToken,
      onMessage: (payload) => settle(endState(payload)),
      // A refused channel and an expired one are the same refusal, so that
      // neither answers whether the number has an account
      // (`realtime/contract.channels.md`). Nothing to show: the status route
      // below is the record, and until it says otherwise this is still `queued`.
      onError: () => {},
    });
    client.connect();

    authApi
      .otpDeliveryStatus(handles.deliveryId)
      .then((status) => settle(endState(status)))
      .catch(() => {
        // Unreachable is not a failed send. The socket may still say so, and
        // the user can resend; claiming a failure here would invent one.
      });

    return () => {
      alive = false;
      leave();
      client.close();
    };
  }, [handles]);

  return { delivery, start, reset };
}
