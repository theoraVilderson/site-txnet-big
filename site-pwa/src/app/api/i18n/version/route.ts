import { NextResponse } from "next/server";
import { getVersion, ensureReady } from "@/lib/locale-store";
import { startWatching } from "@/lib/locale-watcher";

export async function GET() {
  await ensureReady(startWatching);
  return NextResponse.json({ version: getVersion() });
}
