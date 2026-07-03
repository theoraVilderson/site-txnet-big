"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import NatureCaptcha, { CaptchaValidateData } from "./NatureCaptcha";
import { apiReq, handleAxiosError } from "@lib/request";
import type { ResponseType } from "@/shared";
import "./AuthForm.module.css";

export interface AuthFormProps {
  type: "login" | "signup";
}

export default function AuthForm({ type }: AuthFormProps) {
  const router = useRouter();

  // وضعیت‌ها
  const [step, setStep] = useState<1 | 2>(1); // 1: شماره, 2: کد تایید
  const [captchaTokens, setCatptchaTokens] = useState<CaptchaValidateData>();
  const [otpTimer, setOtpTimer] = useState(0);
  const [catpchaReset, setCaptchaReset] = useState(0);
  const [formData, setFormData] = useState({
    phone: "",
    otp: "",
    name: "",
  });

  const [isLoading, setIsLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isSuccess, setIsSuccess] = useState(false);
  const isLogin = type === "login";
  const stepOne = step === 1;
  const stepTwo = step === 2;
  // عناوین متغیر
  const title = stepOne
    ? isLogin
      ? "ورود به حساب"
      : "ثبت‌نام"
    : "تایید شماره";

  const subTitle = stepOne
    ? "شماره موبایل خود را وارد کنید"
    : `کد ارسال شده به ${formData.phone} را وارد کنید`;

  const buttonText = isLoading
    ? "در حال پردازش..."
    : stepOne
      ? "دریافت کد تایید"
      : isLogin
        ? "ورود"
        : "تکمیل ثبت‌نام";

  // Regex شماره موبایل ایران (09 + 9 رقم)
  const iranMobileRegex = /^09[0-9]{9}$/;

  // مدیریت تایمر
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (otpTimer > 0) {
      interval = setInterval(() => {
        setOtpTimer((prev) => prev - 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [otpTimer]);

  const validateStep1 = () => {
    const newErrors: Record<string, string> = {};

    if (!formData.phone) {
      newErrors.phone = "شماره موبایل الزامی است";
    } else if (!iranMobileRegex.test(formData.phone)) {
      newErrors.phone = "شماره موبایل معتبر نیست (مثال: 09121234567)";
    }

    if (!isLogin && !formData.name) {
      newErrors.name = "نام کاربری الزامی است";
    }

    if (!captchaTokens) {
      newErrors.captcha = "لطفا اسلایدر امنیتی را تکمیل کنید";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const validateStep2 = () => {
    const newErrors: Record<string, string> = {};
    if (!formData.otp || formData.otp.length < 5) {
      // فرض بر کد 5 رقمی
      newErrors.otp = "کد تایید کامل نیست";
    }
    setErrors((prev) => ({ ...prev, ...newErrors }));
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    handelStep(step);
  };
  const handelStep = async (forceStep: number = step) => {
    // هندل کردن مرحله اول (ارسال کد)
    if (forceStep == 1) {
      if (!validateStep1()) return;

      setIsLoading(true);
      try {
        // شبیه‌سازی درخواست API ارسال SMS

        const obj: any = { captchaTokens, phone: formData.phone };
        if (type == "signup") {
          obj.name = formData.name;
        }
        const data = await apiReq.post<ResponseType<unknown>>(`/${type}`, obj);
        const result = data.data;
        if (!result.ok) {
          throw new Error(result.msg);
        }
        // رفتن به مرحله بعد
        setStep(2);
        setOtpTimer(120); // 2 دقیقه زمان
        setErrors(
          (prev) =>
            Object.fromEntries(
              Object.keys(prev).map((key) => [key, "1"]),
            ) as typeof prev,
        );
        setFormData((prev) => ({ ...prev, otp: "" }));
      } catch (error) {
        setErrors((prev) => ({
          ...prev,
          form: "خطا در ارسال پیامک. لطفا مجدد تلاش کنید.",
        }));

        handleAxiosError(error);
        setCatptchaTokens(null);
        setCaptchaReset((a) => a + 1);
      } finally {
        setIsLoading(false);
      }
    }
    // هندل کردن مرحله دوم (بررسی کد و ورود)
    else if (forceStep == 2) {
      if (!validateStep2()) return;

      setIsLoading(true);
      try {
        const obj: any = { otp: formData.otp, phone: formData.phone };

        const data = await apiReq.post<ResponseType<{ redirectTo: string }>>(
          `/verifyOTP`,
          obj,
        );
        const result = data.data;
        if (!result.ok) {
          throw new Error(result.msg);
        }
        const sendData = result.data;
        const url = sendData.redirectTo;
        setIsSuccess(true);
        setTimeout(() => {
          router.push(url);
        }, 3000);
      } catch (error) {
        setErrors((prev) => ({ ...prev, otp: "خطا در تایید کد." }));
        handleAxiosError(error);
      } finally {
        setIsLoading(false);
      }
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    // برای فیلدهای عددی فقط عدد بپذیرد
    if ((name === "phone" || name === "otp") && value && !/^\d*$/.test(value)) {
      return;
    }

    setFormData((prev) => ({ ...prev, [name]: value }));
    if (errors[name]) setErrors((prev) => ({ ...prev, [name]: "" }));
    if (errors.form) setErrors((prev) => ({ ...prev, form: "" }));
  };

  const handleResend = () => {
    if (otpTimer === 0) {
      // لاجیک ارسال مجدد
      setOtpTimer(120);
      setStep(1);
    }
  };
  useEffect(() => {
    if (!("OTPCredential" in window) || !stepTwo) return;

    const ac = new AbortController();

    navigator.credentials
      .get({
        otp: { transport: ["sms"] },
        signal: ac.signal,
      } as any)
      .then((otp: any) => {
        if (stepTwo && otp.code) {
          setFormData((d) => ({ ...d, otp: otp.code }));
        }
      })
      .catch(() => {});

    return () => ac.abort();
  }, [stepTwo]);
  return (
    <div className="login-container" dir="rtl">
      <div className={`wellness-card step-${step}`}>
        <div className="organic-border"></div>

        {/* هدر فرم */}
        <div className="mindful-header">
          <div className="zen-logo">
            <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
              {/* همان آیکون قبلی */}
              <circle
                cx="28"
                cy="28"
                r="26"
                stroke="currentColor"
                strokeWidth="2"
                fill="none"
                opacity="0.6"
              />
              <path
                d="M28 15V25M28 32h.01"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
              />
            </svg>
            <div className="zen-glow"></div>
          </div>
          <h1 className="font-bold text-2xl mt-4">{title}</h1>
          <p className="text-sm opacity-80 mt-2">{subTitle}</p>
        </div>

        <form className="harmony-form" onSubmit={handleSubmit} noValidate>
          {/* محتوای مرحله ۱ */}
          {stepOne && (
            <div className="form-step-content fade-in">
              {/* فیلد نام (فقط ثبت نام) */}
              {!isLogin && (
                <div className="organic-field">
                  <div className="field-nature"></div>
                  <input
                    type="text"
                    name="name"
                    id="name"
                    value={formData.name}
                    onChange={handleChange}
                    required
                    placeholder=" "
                  />
                  <label htmlFor="name">نام و نام خانوادگی</label>
                  {errors.name && (
                    <span className="gentle-error show">{errors.name}</span>
                  )}
                </div>
              )}

              {/* فیلد شماره موبایل */}
              <div className="organic-field">
                <div className="field-nature"></div>
                <input
                  type="tel"
                  id="phone"
                  name="phone"
                  value={formData.phone}
                  onChange={handleChange}
                  maxLength={11}
                  required
                  dir="ltr"
                  className="text-center tracking-widest"
                  placeholder=" "
                />
                <label htmlFor="phone">شماره موبایل</label>
                <div className="growth-indicator">
                  <div className="leaf-sprout"></div>
                </div>
              </div>
              {errors.phone && (
                <span className="gentle-error show">{errors.phone}</span>
              )}
              {/* کپچا */}
              <div className="mb-6">
                <NatureCaptcha
                  resetValue={catpchaReset}
                  onVerify={(token) => setCatptchaTokens(token)}
                />
                {errors.captcha && (
                  <span className="gentle-error show text-center">
                    {errors.captcha}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* محتوای مرحله ۲ (OTP) */}
          {stepTwo && (
            <div className="form-step-content fade-in">
              <div className="organic-field">
                <div className="field-nature"></div>
                <input
                  type="tel"
                  id="otp"
                  name="otp"
                  value={formData.otp}
                  onChange={handleChange}
                  maxLength={5}
                  required
                  dir="ltr"
                  className="text-center tracking-[0.5em] font-bold text-lg"
                  placeholder=" "
                  autoFocus
                  autoComplete="one-time-code"
                />
                <label htmlFor="otp">کد تایید</label>
              </div>
              {errors.otp && (
                <span className="gentle-error show">{errors.otp}</span>
              )}
              <div className="text-center mb-6 text-sm">
                {otpTimer > 0 ? (
                  <span className="text-gray-500">
                    ارسال مجدد در {Math.floor(otpTimer / 60)}:
                    {(otpTimer % 60).toString().padStart(2, "0")}
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={handleResend}
                    className="text-blue-600 font-bold hover:underline"
                  >
                    ارسال مجدد کد
                  </button>
                )}
              </div>

              <button
                type="button"
                onClick={() => {
                  setStep(1);
                }}
                className="text-xs text-gray-400 block mx-auto mb-4 hover:text-gray-600"
              >
                اصلاح شماره موبایل
              </button>
            </div>
          )}

          {/* خطای کلی */}
          {errors.form && (
            <div className="p-3 mb-4 rounded-lg bg-red-50 text-red-600 text-xs text-center border border-red-100">
              {errors.form}
            </div>
          )}

          {/* دکمه اصلی */}
          <button
            type="submit"
            className={`harmony-button w-full py-3 relative overflow-hidden group ${
              isLoading ? "loading" : ""
            }`}
            disabled={isLoading}
          >
            <div className="button-earth"></div>
            <span className="button-text relative z-10 font-medium">
              {buttonText}
            </span>
            <div className="button-growth">
              <div className="growing-circle circle-1"></div>
              <div className="growing-circle circle-2"></div>
              <div className="growing-circle circle-3"></div>
            </div>
          </button>
        </form>

        {/* لینک تغییر حالت (فقط در مرحله ۱) */}
        {stepOne && (
          <div className="nurture-signup text-center text-sm mt-6">
            <span className="opacity-70">
              {isLogin ? "حساب کاربری ندارید؟ " : "قبلاً ثبت‌نام کرده‌اید؟ "}
            </span>
            <Link
              href={isLogin ? "/signup" : "/login"}
              className="growth-link text-blue-600 font-bold hover:underline"
            >
              {isLogin ? "ثبت‌نام کنید" : "وارد شوید"}
            </Link>
          </div>
        )}

        {/* پیام موفقیت */}
        {isSuccess && (
          <div className="harmony-success absolute inset-0 bg-[var(--card-bg)] flex flex-col items-center justify-center z-50 rounded-2xl animate-in fade-in zoom-in duration-300">
            <div className="mindful-header">
              <div className="zen-logo">
                <svg width="56" height="56" viewBox="0 0 56 56" fill="none">
                  {/* همان آیکون قبلی */}
                  <circle
                    cx="28"
                    cy="28"
                    r="26"
                    stroke="currentColor"
                    strokeWidth="2"
                    fill="none"
                    opacity="0.6"
                  />
                  <path
                    d="M28 15V25M28 32h.01"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                  />
                </svg>
                <div className="zen-glow"></div>
              </div>
              <h3 className="font-bold text-2xl mt-4 ">پنل تکسنت</h3>
              <p className="text-sm opacity-80 mt-2 ">به تکسنت خوش اومدید</p>
            </div>

            <div className="success-mandala">
              <div className="mandala-ring mandala-ring-1"></div>
              <div className="mandala-ring mandala-ring-2"></div>
              <div className="mandala-ring mandala-ring-3"></div>
              <div className="mandala-center">
                <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                  <path
                    d="M8 14l6 6 12-12"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            </div>

            <div className="">
              <h3>ورود موفقیت آمیز</h3>
              <p>در حال ورود به پنل کاربری...</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
