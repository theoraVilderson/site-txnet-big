"use client";

import { motion } from "framer-motion";
import { useMotionLevel } from "@/hooks/useMotionLevel";
import { fadeRise } from "@/lib/motion";

/**
 * Every panel page enters with `fadeRise` (UX-1-i, `contract.ux.md` M4). A
 * template, unlike the layout, mounts again on each navigation, which is what
 * replays the entrance. There is no exit, so a navigation never waits on one.
 */
export default function PanelTemplate({ children }: { children: React.ReactNode }) {
  const level = useMotionLevel();
  return (
    <motion.div variants={fadeRise(level)} initial="hidden" animate="shown">
      {children}
    </motion.div>
  );
}
