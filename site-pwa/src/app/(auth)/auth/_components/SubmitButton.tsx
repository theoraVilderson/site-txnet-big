"use client";

import { motion } from "framer-motion";
import { Loader2 } from "lucide-react";

interface SubmitButtonProps {
  isLoading: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}

export function SubmitButton({
  isLoading,
  disabled,
  children,
}: SubmitButtonProps) {
  return (
    <motion.button
      layout
      type="submit"
      disabled={isLoading || disabled}
      className="harmony-button mt-2 group"
    >
      <div className="button-earth"></div>
      <span
        className={`button-text flex items-center gap-2 ${
          isLoading ? "opacity-0" : "opacity-100"
        }`}
      >
        {children}
      </span>
      {isLoading && (
        <div className="absolute inset-0 z-20 flex items-center justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-current" />
        </div>
      )}
    </motion.button>
  );
}
