import type { Metadata } from "next";
import "./globals.css";
import "./fonts.css";
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
        {children}
      </body>
    </html>
  );
}
