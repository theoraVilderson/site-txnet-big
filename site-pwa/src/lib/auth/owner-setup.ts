// A fresh install owner's first sign-in (F-0102, auth-api contract.owner-setup.md).
import { loginRequest, setAccessToken } from "./credential";
import type { AuthResult, BotLinkRequired, OtpChannel, OtpDeliveryHandles } from "./sign-in";

/**
 * The password step's setup token, on its way to the setup screen. In memory
 * only: a token in storage would outlive the tab it was meant for, and a
 * reload simply starts again from the sign-in form.
 */
let setupToken: string | null = null;

/** Keeps the password step's setup token for the setup screen. */
export function holdSetupToken(token: string): void {
  setupToken = token;
}

/** The held setup token, or null — read as often as a render asks, cleared only by {@link releaseSetupToken}. */
export function heldSetupToken(): string | null {
  return setupToken;
}

/** Forgets the token once the setup has ended. */
export function releaseSetupToken(): void {
  setupToken = null;
}

/** What `login/password` answers an owner still on the seed's account. */
export type OwnerSetupRequired = { setupRequired: true; setupToken: string };

export type OwnerSetupInput = { setupToken: string; username: string; newPassword: string; phoneNumber: string; otpCode: string };

/** The setup screen's two calls — spread into `authApi`. Sent bare, like every login call: the routes refuse a live session. */
export const ownerSetupCalls = {
  /** The code to the number the owner will keep, or the bot link to connect first. */
  async sendOwnerSetupCode(token: string, phoneNumber: string, channel?: OtpChannel) {
    return loginRequest<(OtpDeliveryHandles & { linkRequired?: undefined }) | BotLinkRequired>("/auth/owner-setup/code", { method: "POST", body: JSON.stringify({ setupToken: token, phoneNumber, ...(channel ? { channel } : {}) }) });
  },
  /** Keeps the owner's username, password and proved phone, and adopts the first session. */
  async completeOwnerSetup(input: OwnerSetupInput) {
    const result = await loginRequest<AuthResult>("/auth/owner-setup", { method: "POST", body: JSON.stringify(input) });
    setAccessToken(result.accessToken);
    return result;
  },
};
