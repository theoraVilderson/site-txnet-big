import {
  fullAuthDomain,
  isDev,
  isProd,
  SMS_PASS,
  SMS_SENDER_PRIVATE,
  SMS_USERNAME,
} from "@/env";
import { lastRes } from "@/shared";
import axios from "axios";
import logger from "./logger";
export const generateOTP = (): string =>
  Math.floor(10000 + Math.random() * 90000).toString();
export async function sendSMS(
  {
    msg,
    to,
    vars = {},
  }: {
    msg: string;
    to: string;
    vars?: { [key: string]: string | number };
  },
  force = isProd
) {
  // if (!force) {
  //   return lastRes(null, "با موفقت ارسال شد حالت دولپر", true);
  // }
  const isHaveVariable = Object.keys(vars).length != 0;
  const replaceVar = (
    msg: string,
    vars: { [key: string]: string | number } = {}
  ) => {
    Object.keys(vars).forEach((key) => {
      const value = vars[key].toString();
      msg = msg.replace(new RegExp(`\{${key}\}`, "g"), value);
    });
    return msg;
  };
  if (isHaveVariable) {
    msg = replaceVar(msg, vars);
  }
  const info = {
    UserName: SMS_USERNAME,

    Password: SMS_PASS,

    From: SMS_SENDER_PRIVATE,

    To: to,

    Message: msg,
  };

  const ans = (await new Promise((res, rej) => {
    axios
      .get<string>("https://webone-sms.ir/SMSInOutBox/SendSms", {
        params: info,
      })
      .then(async function (data) {
        let msg = data.data;
        console.log(data.data);
        if (data.data === "SendWasSuccessful") {
          //YOU‌ CAN‌ CHECK‌ THE‌ RESPONSE‌ AND SEE‌ ERROR‌ OR‌ SUCCESS‌ MESSAGE
          msg = "پیامک با موفقت فرستاده شد";
          return res(lastRes(null, msg, true));
        }
        return res(lastRes(null, msg));
      })
      .catch((e) => {
        let msg = "پیامک فرستاده نشد!";
        console.log(e);
        return res(lastRes(null, msg));
      });
  })) as ReturnType<typeof lastRes<null>>;
  return ans;
}

export async function sendOTP(phone: string, otpCode?: string) {
  const otp = otpCode ?? generateOTP();

  if (isDev) {
    logger.info(`otp send for in dev ${phone}, ${otp}`);
    return lastRes(otp, "کد با موفقیت ارسال شد حالت ", true);
  }

  const OTPMESSAGE = `تکست نت کد تایید پیامکی
کد ارسالی 
your passcode is: {otp}
@{domain} #{otp}`;
  const vars = { otp, domain: fullAuthDomain };
  try {
    const { ok, msg, data } = await sendSMS({
      msg: OTPMESSAGE,
      to: phone,
      vars,
    });
    if (!ok) throw new Error(msg);
    return lastRes(otp, "کد با موفقیت ارسال شد حالت ", true);
  } catch (e) {
    return lastRes(null, "خطا در ارسال کد otp");
  }
}
