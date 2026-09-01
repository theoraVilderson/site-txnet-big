import { NextResponse } from "next/server";
import {
  getLocaleMeta,
  getAvailableLocales,
  ensureReady,
} from "@/lib/locale-store";
import { startWatching } from "@/lib/locale-watcher";

export async function GET() {
  await ensureReady(startWatching);

  const codes = getAvailableLocales();
  const meta: Record<string, unknown> = {};
  for (const code of codes) {
    meta[code] = getLocaleMeta(code);
  }

  return NextResponse.json({ meta, available: codes });
}
