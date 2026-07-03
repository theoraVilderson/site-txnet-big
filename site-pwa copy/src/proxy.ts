// middleware.ts
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  authSubName,
  DOMAIN_NAME,
  fullAuthDomain,
  fullPanelDomain,
  mainSubName,
  panelSubName,
  paymentSubName,
} from "@/env";
import { rateLimiter } from "@lib/rateLimiter";
import { getHostFromHeader, getIpFromHeader } from "@util/helper";
import { validteToken } from "@lib/auth";
import logger from "@lib/logger";
import { err } from "@/shared";

const domainName = process.env.DOMAIN_NAME!;

export async function proxy(request: NextRequest) {
  const url = request.nextUrl;
  const header = request.headers;
  const hostname = getHostFromHeader(header);
  const ip = getIpFromHeader(header);
  const cookies = request.cookies;
  const token = cookies.get("token")?.value ?? "";

  // 1. فایل‌های استاتیک را نادیده بگیر
  if (url.pathname.split("/").pop()!.includes(".")) {
    return NextResponse.next();
  }

  // 2. ریت لیمیت (Rate Limiter)
  try {
    await rateLimiter.consume(ip);
  } catch (rejRes) {
    return NextResponse.json(
      err(" درخواست های مکرر زیاد لطفا چند دقیقه بعد مجدد تلاش کنید"),
      { status: 429 },
    );
  }

  // 3. اعتبارسنجی توکن
  const validateTokenResult = await validteToken(cookies);
  const { ok: validToken } = validateTokenResult;

  let currentHost = hostname.replace(`.${domainName}`, "");
  const path = url.pathname;

  // ============================================================
  // تعریف متغیر response برای ذخیره نتیجه نهایی
  let response: NextResponse;
  const search = url.search; // این حاوی ?type=DEPOSIT&page=1 و غیره است
  logger.info(currentHost);
  logger.info(path);
  logger.info(authSubName);
  switch (currentHost) {
    case authSubName:
      if (!validToken) {
        response = NextResponse.redirect(
          new URL(`/`, `https://${fullPanelDomain}`),
        );
      } else {
        const modifedPath = !path || path == "/" ? "/login" : path;
        // ✅ اضافه کردن search به انتهای مسیر
        response = NextResponse.rewrite(
          new URL(`/auth${modifedPath}${search}`, request.url),
        );
      }
      break;
    case panelSubName:
      if (validToken) {
        const redirectUrl = new URL(
          `/login`,
          `https://${fullAuthDomain}`,
        ).toString();
        response = NextResponse.redirect(redirectUrl);
      } else {
        // ✅ اضافه کردن search برای پنل
        response = NextResponse.rewrite(
          new URL(`/panel${path}${search}`, request.url),
        );
      }
      break;
    case mainSubName:
      // ✅ اضافه کردن search برای صفحه اصلی
      response = NextResponse.rewrite(
        new URL(`/main${path}${search}`, request.url),
      );
      break;
    case paymentSubName:
      // ✅ اضافه کردن search برای صفحه اصلی
      response = NextResponse.rewrite(
        new URL(`/payment${path}${search}`, request.url),
      );
      break;

    default:
      return NextResponse.error();
  }

  // ... داخل تابع proxy

  // ============================================================
  // 4. حذف کوکی (Fix شده)
  // حالا که response ساخته شده، اگر توکن نامعتبر بود، کوکی را از روی آن پاک می‌کنیم
  if (validToken && token) {
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
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
