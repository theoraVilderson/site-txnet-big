import type { Metadata } from "next";
import "./fonts.css";
import "./globals.css";
import { DEFAULT_LOCALE, DEFAULT_DIR } from "@/env";

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
    <html lang={DEFAULT_LOCALE} dir={DEFAULT_DIR}>
      <body>
        {children}
      </body>
    </html>
  );
}
