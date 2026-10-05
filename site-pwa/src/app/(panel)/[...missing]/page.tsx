import { notFound } from "next/navigation";

/**
 * Every panel path no page claims (UX-1-i, N9). A route group's own
 * `not-found.tsx` answers only a `notFound()` thrown inside it, so without this
 * a mistyped address would get Next's bare page, outside the shell. Static
 * routes (`/login`, `/api/…`) still win over a catch-all.
 */
export default function MissingPage() {
  notFound();
}
