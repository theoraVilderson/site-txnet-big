"use client";

import { createContext, useContext } from "react";
import type { GrantKey } from "../../../../_lib/grant-actions";

/**
 * Whether this viewer is offered an act asking a `grant.*` key (KS-1-a,
 * ADR-0140), for the tenant whose user the page shows: `grantKeyHeld` bound to
 * the session and the path's tenant by `UserServicesView`. Default: offer
 * everything, as before the split, and let the door answer.
 */
const MayGrant = createContext<(key: GrantKey) => boolean>(() => true);
export const MayGrantProvider = MayGrant.Provider;
export const useMayGrant = () => useContext(MayGrant);
