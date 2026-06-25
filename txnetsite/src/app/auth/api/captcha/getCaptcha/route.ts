import logger from "@lib/logger";
import { captchaRateLimiter } from "@lib/rateLimiter";
import { getIpFromHeader, sendAsRes } from "@util/helper";
import { NextRequest, NextResponse } from "next/server";

import { createCaptchaToken } from "@lib/captcha";

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
    return res.json(
      sendAsRes(null, "درخواست زیاد کپچا لطفا بعدا امتحان کنید"),
      { status: 429 }
    );
  }
  //
  const token = await createCaptchaToken({ ip });

  return res.json(
    sendAsRes({ token: token.data?.token }, "token created", true),
    {
      status: 201,
    }
  );
}
