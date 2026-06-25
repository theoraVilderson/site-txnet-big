"use client";
import { apiReq, handleAxiosError } from "@lib/request";
import { useEffect, useState } from "react";
import { jwtDecode } from "jwt-decode";
import Skeleton from "@mui/material/Skeleton";
import { NatureCaptchaAction } from "./NatureCaptchaActions";
import { SendResType } from "@/shared";
import * as CryptoJS from "crypto-js";
import { CaptchaSkeleten } from "@/components/Skeleton";
import axios from "axios";

// 1. آرایه کلمات کلیدی (دست‌نخورده باقی مانده تا ساختار بهم نریزد)
// نکته: کلید داخل این آرایه دیگر استفاده نمی‌شود و صرفاً برای گمراهی است.
var _0x5a2b: string[] = [
  "\x4D\x79\x53\x75\x70\x65\x72\x53\x65\x63\x72\x65\x74\x4B\x65\x79\x31\x32\x33",
  "\x65\x6E\x63\x72\x79\x70\x74",
  "\x41\x45\x53",
  "\x74\x6F\x53\x74\x72\x69\x6E\x67",
];

// 2. IIFE برای جابجایی آرایه (Shuffle)
(function (_0x1e3c23: string[], _0x5a2b16: number) {
  var _0x4d7913 = function (_0x25f828: number) {
    while (--_0x25f828) {
      _0x1e3c23["push"](_0x1e3c23["shift"]() as string);
    }
  };
  _0x4d7913(++_0x5a2b16);
})(_0x5a2b, 0x114);

// 3. تابع دیکدر برای بیرون کشیدن متدها
var _0x4d79 = function (_0x1e3c23: any, _0x5a2b16?: any): string {
  _0x1e3c23 = _0x1e3c23 - 0x0;
  var _0x4d7913 = _0x5a2b[_0x1e3c23];
  return _0x4d7913;
};

/**
 * تابع اصلی رمزنگاری
 * @param _0xInput متنی که قراره رمز بشه
 * @param _0xSecretKey کلیدی که باهاش رمز انجام میشه
 */
export function _0x(_0xInput: string, _0xSecretKey: string): string {
  // استخراج نام توابع از آرایه مبهم
  var _0xAES = _0x4d79("0x2"); // 'AES'
  var _0xEnc = _0x4d79("0x1"); // 'encrypt'
  var _0xStr = _0x4d79("0x3"); // 'toString'

  // اجرا: CryptoJS.AES.encrypt(Input, SecretKey).toString()
  return ((CryptoJS as any)[_0xAES] as any)
    [_0xEnc](_0xInput, _0xSecretKey)
    [_0xStr]();
}
export interface CaptchaValidateDataType {
  captchaToken: string;
  verifyToken: string;
}
export type CaptchaValidateData = CaptchaValidateDataType | null;
export interface CaptchaTokenType {
  value: { jti: string; exp: number; ip: string; iat: number };
  token: string;
}
export default function NatureCaptcha({
  onVerify = () => {},
  resetValue,
}: {
  resetValue: number;
  onVerify: (data: CaptchaValidateData) => void;
}) {
  const [token, setToken] = useState<CaptchaTokenType | null>(null);
  const [tokenLoading, setTokenLoading] = useState(true);
  const [isFirstedMount, setIsFirstMount] = useState(false);
  useEffect(() => {
    const abrot = new AbortController();
    async function fetchCaptchaToken() {
      setTokenLoading(true);
      console.log("asd", token);
      try {
        const captchaToken = await apiReq.get<SendResType<{ token: string }>>(
          "/captcha/getCaptcha",
          {
            signal: abrot.signal,
          }
        );
        const result = captchaToken.data;
        const token = result.data.token;
        const status = result.status;
        if (status != "ok") return;
        const tokenExtractedData = jwtDecode<CaptchaTokenType["value"]>(token);
        console.log(tokenExtractedData);
        setToken({
          token,
          value: { ...tokenExtractedData },
        });
      } catch (e: any) {
        // --- بخش مهم: بررسی خطای کنسلی ---
        // اگر خطا به دلیل abort شدن بود، هیچ کاری نکن (ارور نمایش نده)
        if (axios.isCancel(e) || e.name === "CanceledError") {
          console.log("Request aborted");
          return;
        }

        handleAxiosError(e, "خطا در بارگذاری نوار تایید هویت");
      } finally {
        setTokenLoading(false);
      }
    }
    !token && fetchCaptchaToken();

    return () => abrot.abort();
  }, [token?.token]);

  useEffect(() => {
    console.log("asd2323", token);
    if (!token) return;
    const isCaptchaExpired = () => {
      return Date.now() > new Date(token.value.exp * 1000).getTime();
    };
    const timer = setInterval(() => {
      const isExpired = isCaptchaExpired();

      if (isExpired) {
        setToken(null);
        clearInterval(timer);
      }
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [token?.token]);

  useEffect(() => {
    if (isFirstedMount) {
      setIsFirstMount(false);
      return;
    }
    setToken(null);
  }, [resetValue]);
  return tokenLoading || !token?.token ? (
    <CaptchaSkeleten />
  ) : (
    <NatureCaptchaAction onVerify={onVerify} token={token} />
  );
}
