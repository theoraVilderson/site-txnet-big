"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Copy, CheckCheck, Home, LayoutDashboard } from "lucide-react";

// انیمیشن‌های کلی کانتینر
const containerVariants: any = {
  hidden: { opacity: 0, scale: 0.95 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: {
      duration: 0.5,
      ease: [0.22, 1, 0.36, 1],
      staggerChildren: 0.15, // هر آیتم با تاخیر 0.15 ثانیه نسبت به قبلی میاد
    },
  },
};

// انیمیشن برای هر آیتم داخلی
const itemVariants: any = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 100 } },
};
interface props {
  panelURL: string;
}
function SuccessContent({ panelURL }: props) {
  const searchParams = useSearchParams();

  const refId = searchParams.get("ref");
  const isAlreadyPaid = searchParams.get("already_paid") === "true";
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (refId) {
      navigator.clipboard.writeText(refId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="min-h-screen w-full flex items-center justify-center p-4 bg-[image:var(--background)] overflow-hidden relative">
      {/* Background Blobs (Framer Motion Floating) */}
      <motion.div
        animate={{ y: [0, -20, 0], opacity: [0.5, 0.8, 0.5] }}
        transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
        className="absolute top-10 right-10 w-64 h-64 bg-[var(--leaf-bg)] rounded-full blur-3xl"
      />
      <motion.div
        animate={{ y: [0, 20, 0], opacity: [0.5, 0.8, 0.5] }}
        transition={{
          duration: 7,
          repeat: Infinity,
          ease: "easeInOut",
          delay: 1,
        }}
        className="absolute bottom-10 left-10 w-64 h-64 bg-[var(--gold-bg)] rounded-full blur-3xl"
      />

      <motion.div
        variants={containerVariants}
        initial="hidden"
        animate="visible"
        className="w-full max-w-md relative z-10"
      >
        <div className="relative overflow-hidden rounded-3xl border border-[var(--card-border)] bg-[var(--card-bg)] p-8 shadow-[0_8px_32px_var(--card-shadow)] backdrop-blur-xl">
          <div className="flex flex-col items-center text-center">
            {/* Animated Checkmark Circle */}
            <motion.div
              variants={itemVariants}
              className="mb-6 flex h-24 w-24 items-center justify-center rounded-full bg-[var(--bg-inner)] shadow-inner ring-4 ring-[var(--accent-glow)]"
            >
              <svg
                className="w-12 h-12 text-[var(--accent-primary)]"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <motion.path
                  d="M20 6L9 17l-5-5"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 0.8, delay: 0.4, ease: "easeOut" }}
                />
              </svg>
            </motion.div>

            <motion.h1
              variants={itemVariants}
              className="mb-2 text-2xl font-bold text-[var(--text-primary)]"
            >
              {refId ? "پرداخت موفق" : "پرداخت ناموفق"}
            </motion.h1>

            {
              <motion.p
                variants={itemVariants}
                className="mb-8 text-sm text-[var(--text-secondary)] leading-relaxed"
              >
                {refId
                  ? isAlreadyPaid
                    ? "تراکنش قبلاً انجام شده"
                    : "پرداخت با موفقیت انجام شد"
                  : "خطا در پرداخت"}
              </motion.p>
            }
            {/* Reference ID Card */}
            {refId && (
              <motion.div
                variants={itemVariants}
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.98 }}
                onClick={handleCopy}
                className="group relative mb-8 w-full cursor-pointer overflow-hidden rounded-xl border border-[var(--gold-glow)] bg-[var(--gold-bg)] p-4 transition-colors"
              >
                <div className="flex flex-col items-center gap-2">
                  <span className="text-xs font-medium text-[var(--gold-primary)] opacity-80 uppercase tracking-widest">
                    کد رهگیری
                  </span>
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-xl font-bold tracking-widest text-[var(--text-primary)]">
                      {refId}
                    </span>
                    <div className="text-[var(--gold-primary)] opacity-60">
                      <AnimatePresence mode="wait">
                        {copied ? (
                          <motion.div
                            key="check"
                            initial={{ scale: 0, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0, opacity: 0 }}
                          >
                            <CheckCheck className="w-5 h-5" />
                          </motion.div>
                        ) : (
                          <motion.div
                            key="copy"
                            initial={{ scale: 0, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0, opacity: 0 }}
                          >
                            <Copy className="w-4 h-4" />
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </div>
                </div>
                {copied && (
                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="absolute inset-0 bg-[var(--gold-primary)]/10 flex items-center justify-center backdrop-blur-[1px]"
                  >
                    <span className="text-xs font-bold text-[var(--gold-primary)]">
                      کپی شد!
                    </span>
                  </motion.div>
                )}
              </motion.div>
            )}

            {/* Buttons */}
            <motion.div variants={itemVariants} className="w-full space-y-3">
              <Link href={`${panelURL}/`} className="block w-full">
                <motion.button
                  whileHover={{
                    scale: 1.02,
                    boxShadow: "0 0 20px var(--accent-glow)",
                  }}
                  whileTap={{ scale: 0.98 }}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--card-gradient)] py-3.5 text-white font-medium shadow-lg"
                >
                  <LayoutDashboard className="w-5 h-5" />
                  بازگشت به پنل کاربری
                </motion.button>
              </Link>
            </motion.div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

export default function PaymentSuccessPage({ panelURL }: props) {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-[var(--background)] flex items-center justify-center text-[var(--text-primary)]">
          در حال بارگذاری...
        </div>
      }
    >
      <SuccessContent panelURL={panelURL} />
    </Suspense>
  );
}
