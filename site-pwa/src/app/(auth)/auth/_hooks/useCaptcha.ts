"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { authApi } from "@/lib/auth-api";

/**
 * A challenge older than this is renewed before it is slid against. The server
 * forgets one after 60s (`RedisTtl.captchaChallenge`); the 10s margin covers
 * the round trip and the drag itself. Without it, a user who spends a minute
 * on the form slides against a dead id and the thumb snaps back once.
 */
const CHALLENGE_FRESH_MS = 50_000;
/**
 * Mirrors `MIN_INTERACTION_MS` in auth-service, with room for clock skew: a
 * challenge fetched on the slide itself must age this long before `/verify`,
 * or the server rejects it as too fast to be a drag.
 */
const MIN_CHALLENGE_AGE_MS = 400;

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
  const challengeFetchedAtRef = useRef(0);
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const renewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // the renewal re-enters `requestChallenge`, which cannot name itself
  const renewRef = useRef<() => void>(() => {});

  const requestChallenge = useCallback(() => {
    setVerified(false);
    setToken(null);
    challengeIdRef.current = null;
    clearTimeout(renewTimer.current);
    const request = (async () => {
      try {
        const { challengeId } = await authApi.captchaChallenge();
        challengeIdRef.current = challengeId;
        challengeFetchedAtRef.current = Date.now();
        renewTimer.current = setTimeout(() => renewRef.current(), CHALLENGE_FRESH_MS);
      } catch {
        challengeIdRef.current = null;
      }
    })();
    challengeRequestRef.current = request;
    return request;
  }, []);

  useEffect(() => {
    renewRef.current = () => void requestChallenge();
  }, [requestChallenge]);

  useEffect(() => {
    // the mount fetch clears any previous pass before it starts; at mount
    // those setState calls are no-ops, so this cannot loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    requestChallenge();
    return () => {
      clearTimeout(expiryTimer.current);
      clearTimeout(renewTimer.current);
    };
  }, [requestChallenge]);

  const complete = useCallback(async () => {
    await challengeRequestRef.current;
    // The renewal timer does not run while a laptop sleeps, so the wall clock
    // is the check. A challenge fetched here is too young for the server's
    // minimum-interaction rule, so it is aged before it is sent.
    if (challengeIdRef.current && Date.now() - challengeFetchedAtRef.current >= CHALLENGE_FRESH_MS) {
      await requestChallenge();
      await new Promise((resolve) => setTimeout(resolve, MIN_CHALLENGE_AGE_MS));
    }
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
      // the challenge is burnt now; renewing it would drop the pass just won
      clearTimeout(renewTimer.current);
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
