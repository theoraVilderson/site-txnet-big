// middleware.ts
import type { NextRequest } from "next/server";

export async function proxy(request: NextRequest) {
  return null;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
