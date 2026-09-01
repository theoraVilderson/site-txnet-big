"use client";

import { ThemeProvider, type ThemeChoice } from "@/context/ThemeContext";
import type { ThemeName } from "@/env";

export function ThemeShell({
  children,
  initialTheme,
  initialChoice,
}: {
  children: React.ReactNode;
  initialTheme: ThemeName;
  initialChoice: ThemeChoice;
}) {
  return (
    <ThemeProvider initialTheme={initialTheme} initialChoice={initialChoice}>
      {children}
    </ThemeProvider>
  );
}
