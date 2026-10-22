"use client";

import { useState } from "react";
import { toggleTickedUser } from "../../../_lib/bulk-move";

/**
 * The users ticked on the users list for a bulk move (F-311-ae), kept across
 * its pages and searches: an admin gathers the users of a failing server from
 * several searches before moving them.
 */
export function useTickedUsers() {
  const [ticked, setTicked] = useState<string[]>([]);
  return {
    ticked,
    toggle: (userId: string) => setTicked((before) => toggleTickedUser(before, userId)),
    clear: () => setTicked([]),
  };
}
