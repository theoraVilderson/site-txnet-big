import { NextRequest, NextResponse } from "next/server";

const API_ORIGIN = process.env.AUTH_API_ORIGIN ?? "https://api.txnet.cyou";

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const target = `${API_ORIGIN}/api/auth/${path.join("/")}`;
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("origin");

  const response = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
    redirect: "manual",
  });

  const result = new NextResponse(response.body, { status: response.status, statusText: response.statusText });
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "content-encoding") result.headers.set(key, value);
  });
  return result;
}

export const OPTIONS = () => new NextResponse(null, { status: 204 });
export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
