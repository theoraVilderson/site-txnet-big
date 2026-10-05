import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Class names for a kit primitive and the caller's `className` after it, with
 * Tailwind conflicts resolved so the caller's wins (`h-8` over the kit's `h-10`).
 */
export function cn(...values: ClassValue[]): string {
  return twMerge(clsx(values));
}
