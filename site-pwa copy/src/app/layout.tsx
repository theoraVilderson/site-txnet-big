import type { Metadata } from "next";
import "./fonts.css";
import "./globals.css";
import { ThemeProvider } from "@/components/ThemeProvider";
import { ThemeToggle } from "@/components/ThemeToggle";
import FloatingLeaves from "@/components/FloatingLeaves";
import { Toaster } from "react-hot-toast";

export const metadata: Metadata = {
  title: "تکسنت - txnet",
  description: "پنل کاربری تکسنت",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fa" dir="rtl" suppressHydrationWarning>
      <body
        className={`bg-eco-50 dark:bg-slate-950 transition-colors duration-300`}
      >
        <ThemeProvider>
          <Toaster />
          <FloatingLeaves />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
