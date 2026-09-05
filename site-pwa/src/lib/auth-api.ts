// Browser calls api.${DOMAIN_NAME} directly (cross-origin, cookie-bearing) —
// no Next.js proxy hop. Backend CORS (main.ts) allows this origin with
// credentials; see docs/interfaces/auth-api/contract.md.
const API_URL = `${process.env.NEXT_PUBLIC_API_ORIGIN}/api`;
let accessToken: string | null = null;

async function request<T>(path: string, init: RequestInit = {}, captchaToken?: string): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  if (captchaToken) headers.set("x-captcha-token", captchaToken);
  const response = await fetch(`${API_URL}${path}`, { ...init, headers, credentials: "include" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(body.msg ?? "Request failed");
  }
  return body.data as T;
}

export type AuthResult = { accessToken: string; expiresIn: number };
export type CaptchaChallenge = { challengeId: string };
export type CaptchaPass = { token: string; expiresIn: number };

export const authApi = {
  async loginPassword(identifier: string, password: string, captchaToken: string) {
    const result = await request<AuthResult | { requiresOtp: boolean }>("/auth/login/password", { method: "POST", body: JSON.stringify({ identifier, password }) }, captchaToken);
    if ("accessToken" in result) accessToken = result.accessToken;
    return result;
  },
  async requestLoginOtp(phoneNumber: string, captchaToken: string) { return request<{ accepted: boolean }>("/auth/login/otp/request", { method: "POST", body: JSON.stringify({ phoneNumber }) }, captchaToken); },
  async verifyLoginOtp(phoneNumber: string, otpCode: string) { const result = await request<AuthResult>("/auth/login/otp/verify", { method: "POST", body: JSON.stringify({ phoneNumber, otpCode }) }); accessToken = result.accessToken; return result; },
  async register(input: { fullName: string; username: string; phoneNumber: string; password: string }, captchaToken: string) { return request<{ phoneNumber: string; requiresPhoneVerification: boolean }>("/auth/register", { method: "POST", body: JSON.stringify(input) }, captchaToken); },
  async verifyPhone(phoneNumber: string, otpCode: string) { const result = await request<AuthResult & { userId: string }>("/auth/register/verify-phone", { method: "POST", body: JSON.stringify({ phoneNumber, otpCode }) }); accessToken = result.accessToken; return result; },
  async forgot(phoneNumber: string, captchaToken: string) { return request<{ accepted: boolean }>("/auth/password/forgot", { method: "POST", body: JSON.stringify({ phoneNumber }) }, captchaToken); },
  async verifyForgot(phoneNumber: string, otpCode: string) { return request<{ resetToken: string }>("/auth/password/forgot/verify-otp", { method: "POST", body: JSON.stringify({ phoneNumber, otpCode }) }); },
  async reset(resetToken: string, newPassword: string) { return request<{ success: boolean }>("/auth/password/reset", { method: "POST", body: JSON.stringify({ resetToken, newPassword }) }); },
  async refresh() { const result = await request<AuthResult>("/auth/refresh", { method: "POST", body: JSON.stringify({}) }); accessToken = result.accessToken; return result; },
  async logout() { const result = await request<{ success: boolean }>("/auth/logout", { method: "POST", body: JSON.stringify({}) }); accessToken = null; return result; },
  getAccessToken() { return accessToken; },
  // Server-verified slide challenge (F-0201) — see docs/interfaces/auth-api/contract.md
  async captchaChallenge() { return request<CaptchaChallenge>("/auth/captcha/challenge", { method: "POST", body: JSON.stringify({}) }); },
  async captchaVerify(challengeId: string) { return request<CaptchaPass>("/auth/captcha/verify", { method: "POST", body: JSON.stringify({ challengeId }) }); },
};
