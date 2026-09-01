import { NextRequest, NextResponse } from "next/server";
import { getNamespace, ensureReady } from "@/lib/locale-store";
import { startWatching } from "@/lib/locale-watcher";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ lang: string; ns: string }> },
) {
  await ensureReady(startWatching);

  const { lang, ns } = await params;
  const data = getNamespace(lang, ns);

  if (!data) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  return NextResponse.json(data);
}
