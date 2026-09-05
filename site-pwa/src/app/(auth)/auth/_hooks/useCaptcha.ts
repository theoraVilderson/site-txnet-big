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
  const expiryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const requestChallenge = useCallback(async () => {
    setVerified(false);
    setToken(null);
    try {
      const { challengeId } = await authApi.captchaChallenge();
      challengeIdRef.current = challengeId;
    } catch {
      challengeIdRef.current = null;
    }
  }, []);

  useEffect(() => {
    requestChallenge();
    return () => clearTimeout(expiryTimer.current);
  }, [requestChallenge]);

  const complete = useCallback(async () => {
    const challengeId = challengeIdRef.current;
    if (!challengeId) return;
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

  return { verified, token, complete };
}
