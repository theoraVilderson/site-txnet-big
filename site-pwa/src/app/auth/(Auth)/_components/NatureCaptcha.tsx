"use client";
import { apiReq, handleAxiosError } from "@lib/request";
import { useEffect, useState } from "react";
import { jwtDecode } from "jwt-decode";
import { NatureCaptchaAction } from "./NatureCaptchaActions";
import { CaptchaSkeleten } from "@/components/Skeleton";
import axios from "axios";
import type { ResponseType } from "@/shared";

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
      try {
        const captchaToken = await apiReq.get<ResponseType<{ token: string }>>(
          "/captcha/getCaptcha",
          {
            signal: abrot.signal,
          },
        );
        const result = captchaToken.data;
        if (!result.ok) return;
        const token = result.data.token;
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
