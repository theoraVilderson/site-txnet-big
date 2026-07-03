import logger from "@lib/logger";
import { captchaRateLimiter } from "@lib/rateLimiter";
import { getIpFromHeader } from "@util/helper";
import { NextRequest, NextResponse } from "next/server";

import { createCaptchaToken } from "@lib/captcha";
import { err, ok } from "@/shared";

export async function GET(req: NextRequest) {
  const res = NextResponse;
  const header = req.headers;
  const cookies = req.cookies;
  const ip = getIpFromHeader(header);
  // captcha
  try {
    await captchaRateLimiter.consume(ip);
  } catch (e) {
    logger.error(e);
    return res.json(err("درخواست زیاد کپچا لطفا بعدا امتحان کنید"), {
      status: 429,
    });
  }
  //
  const tokenCreationRes = await createCaptchaToken({ ip });
  if (!tokenCreationRes.ok) {
    logger.error(tokenCreationRes.msg);
    return res.json(err("حطا در ساخت توکن کاربر"), {
      status: 500,
    });
  }
  return res.json(ok({ token: tokenCreationRes.data.token }, "token created"), {
    status: 201,
  });
}
