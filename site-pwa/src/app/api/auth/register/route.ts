import { NextRequest, NextResponse } from "next/server";

const API_ORIGIN = process.env.AUTH_API_ORIGIN ?? "https://api.txnet.cyou";

export async function POST(request: NextRequest) {
  const response = await fetch(`${API_ORIGIN}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": request.headers.get("content-type") ?? "application/json" },
    body: await request.arrayBuffer(),
  });
  const result = new NextResponse(response.body, { status: response.status });
  response.headers.forEach((value, key) => result.headers.set(key, value));
  return result;
}
