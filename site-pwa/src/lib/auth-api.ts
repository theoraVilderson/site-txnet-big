const API_URL = "/api";
let accessToken: string | null = null;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (accessToken) headers.set("authorization", `Bearer ${accessToken}`);
  const response = await fetch(`${API_URL}${path}`, { ...init, headers, credentials: "include" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message ?? "Request failed");
  }
  return response.json() as Promise<T>;
}

export type AuthResult = { accessToken: string; expiresIn: number };

export const authApi = {
  async loginPassword(identifier: string, password: string) {
    const result = await request<AuthResult | { requiresOtp: boolean }>("/auth/login/password", { method: "POST", body: JSON.stringify({ identifier, password }) });
    if ("accessToken" in result) accessToken = result.accessToken;
    return result;
  },
  async requestLoginOtp(phoneNumber: string) { return request<{ accepted: boolean }>("/auth/login/otp/request", { method: "POST", body: JSON.stringify({ phoneNumber }) }); },
  async verifyLoginOtp(phoneNumber: string, otpCode: string) { const result = await request<AuthResult>("/auth/login/otp/verify", { method: "POST", body: JSON.stringify({ phoneNumber, otpCode }) }); accessToken = result.accessToken; return result; },
  async register(input: { fullName: string; username: string; phoneNumber: string; password: string }) { return request<{ userId: string; requiresPhoneVerification: boolean }>("/auth/register", { method: "POST", body: JSON.stringify(input) }); },
  async verifyPhone(userId: string, otpCode: string) { const result = await request<AuthResult & { userId: string }>("/auth/register/verify-phone", { method: "POST", body: JSON.stringify({ userId, otpCode }) }); accessToken = result.accessToken; return result; },
  async forgot(phoneNumber: string) { return request<{ accepted: boolean }>("/auth/password/forgot", { method: "POST", body: JSON.stringify({ phoneNumber }) }); },
  async verifyForgot(phoneNumber: string, otpCode: string) { return request<{ resetToken: string }>("/auth/password/forgot/verify-otp", { method: "POST", body: JSON.stringify({ phoneNumber, otpCode }) }); },
  async reset(resetToken: string, newPassword: string) { return request<{ success: boolean }>("/auth/password/reset", { method: "POST", body: JSON.stringify({ resetToken, newPassword }) }); },
  async refresh() { const result = await request<AuthResult>("/auth/refresh", { method: "POST", body: JSON.stringify({}) }); accessToken = result.accessToken; return result; },
  async logout() { const result = await request<{ success: boolean }>("/auth/logout", { method: "POST", body: JSON.stringify({}) }); accessToken = null; return result; },
  getAccessToken() { return accessToken; },
};
