"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authApi } from "@/lib/auth-api";

/**
 * Drives the server-verified slide challenge (F-0201): requests a challenge
 * up front, exchanges a completed slide for a short-lived pass, and drops
 * back to unverified when that pass expires (TTL mirrored from
 * `RedisTtl.captchaVerified` in auth-service) so the user must slide again.
 */
export function useCaptcha() {
  const [verified, setVerified] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const challengeIdRef = useRef<string | null>(null);
  // The challenge is fetched on mount, so a user who slides immediately gets
  // there before the id does. Without a handle on the in-flight request,
  // `complete` would find `challengeIdRef` null, return, and the widget would
  // snap the thumb back to the start — the "wait a second, then it works"
  // behaviour. Awaiting this promise makes the early slide queue instead.
  const challengeRequestRef = useRef<Promise<void> | null>(null);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const requestChallenge = useCallback(() => {
    setVerified(false);
    setToken(null);
    challengeIdRef.current = null;
    const request = (async () => {
      try {
        const { challengeId } = await authApi.captchaChallenge();
        challengeIdRef.current = challengeId;
      } catch {
        challengeIdRef.current = null;
      }
    })();
    challengeRequestRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    // the mount fetch clears any previous pass before it starts; at mount
    // those setState calls are no-ops, so this cannot loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    requestChallenge();
    return () => clearTimeout(expiryTimer.current);
  }, [requestChallenge]);

  const complete = useCallback(async () => {
    await challengeRequestRef.current;
    let challengeId = challengeIdRef.current;
    if (!challengeId) {
      // The first fetch failed (offline, a hiccup). Try once more rather than
      // leaving the user with a slider that silently does nothing.
      await requestChallenge();
      challengeId = challengeIdRef.current;
      if (!challengeId) return;
    }
    try {
      const pass = await authApi.captchaVerify(challengeId);
      setToken(pass.token);
      setVerified(true);
      clearTimeout(expiryTimer.current);
      expiryTimer.current = setTimeout(requestChallenge, pass.expiresIn * 1000);
    } catch {
      await requestChallenge();
    }
  }, [requestChallenge]);

  /**
   * Call once a pass has been handed to an endpoint. The server burns it on
   * use, so the widget must not keep showing "verified": if the user comes
   * back to edit what they submitted and sends again, that second request
   * needs a slide of its own against a fresh challenge.
   */
  const spend = useCallback(() => {
    clearTimeout(expiryTimer.current);
    void requestChallenge();
  }, [requestChallenge]);

  return { verified, token, complete, spend };
}
