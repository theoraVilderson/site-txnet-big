"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { useAuthUI } from "@auth/auth/_context/AuthUIContext";
import { AUTH_LOGIN, AUTH_REGISTER } from "@/lib/routes";

type FooterVariant = "login" | "register" | "forgot-password";

export function AuthFooterLinks({ variant }: { variant: FooterVariant }) {
  const { t } = useAuthUI();

  return (
    <motion.div
      layout
      className="flex flex-col items-center gap-3 mt-6 pt-4 border-t border-card-border text-sm"
    >
      {variant === "login" && (
        <>
          <Link
            href="/auth/forgot-password"
            className="text-text-secondary hover:text-primary font-medium transition-colors"
          >
            {t.forgotPassword}
          </Link>
          <div className="text-text-secondary">
            {t.noAccount}{" "}
            <Link
              href={AUTH_REGISTER}
              className="text-primary font-bold hover:underline"
            >
              {t.register}
            </Link>
          </div>
        </>
      )}

      {variant === "register" && (
        <div className="text-text-secondary">
          {t.alreadyRegistered}{" "}
          <Link
            href={AUTH_LOGIN}
            className="text-primary font-bold hover:underline"
          >
            {t.login}
          </Link>
        </div>
      )}

      {variant === "forgot-password" && (
        <div className="text-text-secondary">
          {t.backTo}{" "}
          <Link
            href={AUTH_LOGIN}
            className="text-primary font-bold hover:underline"
          >
            {t.loginPage}
          </Link>
        </div>
      )}
    </motion.div>
  );
}
