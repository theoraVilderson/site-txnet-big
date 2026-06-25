import type { Metadata } from "next";
import "./fonts.css";
import "./globals.css";
import { useEffect } from "react";
import { initTheme } from "@util/theme";

export const metadata: Metadata = {
  title: "تکسنت - txnet",
  description: "پنل کاربری تکسنت",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  useEffect(() => {
    initTheme();
  }, []);
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
