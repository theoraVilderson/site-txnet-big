"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { AlertCircle, RefreshCw, Headset } from "lucide-react";

// انیمیشن‌های کلی
const containerVariants: any = {
  hidden: { opacity: 0, scale: 0.9 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: {
      duration: 0.4,
      ease: "easeOut",
      staggerChildren: 0.1,
    },
  },
};

const itemVariants: any = {
  hidden: { opacity: 0, y: 15 },
  visible: { opacity: 1, y: 0 },
};
interface props {
  panelURL: string;
}
const ERROR_MESSAGES: Record<string, string> = {
  INVALID_PARAMS: "اطلاعات پرداخت نامعتبر است.",
  TRANSACTION_NOT_FOUND: "تراکنش یافت نشد.",
  GATEWAY_CONNECTION_ERROR: "مشکل در برقراری ارتباط با بانک.",
  VERIFICATION_FAILED: "پرداخت توسط بانک تایید نشد یا لغو شده است.",
  SYSTEM_ERROR:
    "پرداخت موفق بود اما در شارژ کیف پول خطایی رخ داد. با پشتیبانی تماس بگیرید.",
  INTERNAL_SERVER_ERROR: "خطای ناشناخته سرور.",
};

function FailedContent({ panelURL }: props) {
  const searchParams = useSearchParams();
  const errorCode = searchParams.get("error");
  const message =
    ERROR_MESSAGES[errorCode as string] || "عملیات پرداخت با خطا مواجه شد.";

  return (
    <div className="min-h-screen w-full flex items-center justify-center p-4 bg-[image:var(--background)] overflow-hidden relative">
      {/* Red Ambient Light */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.4 }}
        transition={{ duration: 1 }}
        className="absolute top-0 left-0 w-full h-full bg-gradient-to-b from-[var(--error-bg)]/20 to-transparent pointer-events-none"
      />

      <motion.div
        variants={containerVariants}
        initial="hidden"
        animate="visible"
        className="w-full max-w-md relative z-10"
      >
        <div className="relative overflow-hidden rounded-3xl border border-[var(--error-border)] bg-[var(--card-bg)] p-8 shadow-[0_8px_32px_rgba(200,50,50,0.1)] backdrop-blur-xl">
          <div className="flex flex-col items-center text-center">
            {/* Animated Error Icon (Shake Effect) */}
            <motion.div
              variants={itemVariants}
              className="mb-6 flex h-24 w-24 items-center justify-center rounded-full bg-[var(--error-bg)] shadow-inner ring-4 ring-[var(--error-border)]"
            >
              <motion.div
                animate={{
                  x: [0, -5, 5, -5, 5, 0],
                  rotate: [0, -5, 5, -3, 3, 0],
                }}
                transition={{ duration: 0.6, delay: 0.4, ease: "easeInOut" }}
              >
                <AlertCircle className="w-12 h-12 text-[var(--error-color)]" />
              </motion.div>
            </motion.div>

            <motion.h1
              variants={itemVariants}
              className="mb-2 text-2xl font-bold text-[var(--error-color)]"
            >
              پرداخت ناموفق
            </motion.h1>

            <motion.p
              variants={itemVariants}
              className="mb-6 text-sm text-[var(--text-secondary)]"
            >
              متاسفانه عملیات پرداخت با خطا مواجه شد و مبلغی کسر نگردید.
            </motion.p>

            {/* Error Details */}
            <motion.div
              variants={itemVariants}
              className="mb-8 w-full rounded-xl border border-[var(--error-border)] bg-[var(--error-bg)]/30 p-4"
            >
              <div className="flex flex-col gap-1">
                {errorCode && (
                  <span className="font-mono text-[10px] uppercase text-[var(--error-color)] opacity-75 tracking-wider">
                    Error Code: {errorCode}
                  </span>
                )}
                <span className="text-sm font-medium text-[var(--text-primary)] leading-snug">
                  {message
                    ? decodeURIComponent(message)
                    : "خطای ناشناخته در ارتباط با درگاه پرداخت."}
                </span>
              </div>
            </motion.div>

            {/* Actions */}
            <motion.div variants={itemVariants} className="w-full space-y-3">
              <Link
                href={`${panelURL}/financial/deposit`}
                className="block w-full"
              >
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.98 }}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--error-color)] py-3.5 text-white font-medium shadow-lg shadow-[var(--error-border)]"
                >
                  <RefreshCw className="w-5 h-5" />
                  تلاش مجدد
                </motion.button>
              </Link>

              <Link href={`${panelURL}/support/`} className="block w-full">
                <motion.button
                  whileHover={{ x: 5, color: "var(--text-primary)" }}
                  className="flex w-full items-center justify-center gap-2 py-2 text-sm text-[var(--text-secondary)] transition-colors"
                >
                  <Headset className="w-4 h-4" />
                  تماس با پشتیبانی
                </motion.button>
              </Link>
            </motion.div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

export default function PaymentFailedPage({ panelURL }: props) {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[var(--background)] flex items-center justify-center text-[var(--error-color)]">
          در حال پردازش خطا...
        </div>
      }
    >
      <FailedContent panelURL={panelURL} />
    </Suspense>
  );
}
