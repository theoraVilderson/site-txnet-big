import { NextRequest, NextResponse } from "next/server";
import { revokeToken } from "@lib/session";
import { DOMAIN_NAME } from "@/env";

export async function POST(request: NextRequest) {
  const token = request.cookies.get("token")?.value;

  if (token) {
    // افزودن JTI به بلاک‌لیست ردیس
    await revokeToken(token);
  }

  const response = NextResponse.json({ success: true, message: "Logged out" });

  // پاک کردن کوکی از مرورگر
  response.cookies.set({
    name: "token",
    value: "",
    path: "/",
    maxAge: 0, // این باعث حذف فوری می‌شود
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    domain: `.${DOMAIN_NAME}`, // مطمئن شوید DOMAIN_NAME درست است
  });

  return response;
}
