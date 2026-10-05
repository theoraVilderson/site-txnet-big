import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "@/lib/api-error";
import { passwordChecks, passwordStrength } from "../_lib/password";
import { ConfirmProvider } from "../../_components/kit/confirm";
import { ProfileSection } from "./ProfileSection";

/**
 * Settings > Profile: the name edited in place and the password changed signed
 * in (UX-1-u, `contract.ux.md` S3–S4, over auth-api v41).
 *
 * > **"Sign out every other place" is ticked unless the user unticks it, and a
 * > wrong current password is said under that field — not as a sign-out.**
 *
 * A password is usually changed because someone else may know it, so the safe
 * choice is the default. And the route answers a wrong current password with
 * 400 `wrong_password`: the session is fine, so the form keeps it and points
 * at the one field to fix.
 */

const renameMe = vi.fn();
const changePassword = vi.fn();
const reload = vi.fn();
const success = vi.fn();
const me = { fullName: "Behnam Tabrizi" };

vi.mock("@/context/LocaleContext", () => ({ useLocale: () => ({ t, lang: "en" }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/useMotionLevel", () => ({ useMotionLevel: () => "reduced" }));
vi.mock("@/lib/auth-api", () => ({
  authApi: {
    renameMe: (...a: unknown[]) => renameMe(...a),
    changePassword: (...a: unknown[]) => changePassword(...a),
  },
}));
vi.mock("../../_context/PanelSessionContext", () => ({ usePanelSession: () => ({ me, reload }) }));
vi.mock("../../_components/kit/notify", () => ({ notify: { success: (...a: unknown[]) => success(...a), error: vi.fn() } }));
vi.mock("@/hooks/useApiError", () => ({ useApiErrorMessage: () => (e: unknown) => (e instanceof Error ? e.message : "error") }));

/** The key back, so an assertion names the string the component asked for. */
const t = (_ns: string, key: string) => key;

const STRONG = "New-pass2!";

/** The panel layout mounts the confirm the SaveBar's leave guard asks through. */
const view = () => render(<ConfirmProvider><ProfileSection /></ConfirmProvider>);

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe("password strength", () => {
  it("checks the register form's five rules, and rates by how many hold", () => {
    expect(passwordChecks("abc")).toEqual({ length: false, lower: true, upper: false, digit: false, special: false });
    expect(passwordChecks(STRONG)).toEqual({ length: true, lower: true, upper: true, digit: true, special: true });
    expect(passwordStrength("")).toBe(0);
    expect(passwordStrength("abcdefgh")).toBe(1);
    expect(passwordStrength(STRONG)).toBe(4);
  });
});

describe("the profile section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    renameMe.mockResolvedValue({ fullName: "Behnam T" });
    changePassword.mockResolvedValue({ otherSessionsEnded: 2 });
  });

  it("turns the name into a field in place, saves it trimmed, and reloads the session", async () => {
    view();
    expect(screen.getByText("Behnam Tabrizi")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "settings.profile.name.edit" }));
    fill("settings.profile.name.label", "  Behnam T ");
    fireEvent.click(screen.getByRole("button", { name: "settings.profile.name.save" }));

    await waitFor(() => expect(renameMe).toHaveBeenCalledWith("Behnam T"));
    expect(reload).toHaveBeenCalled();
    expect(success).toHaveBeenCalledWith("settings.profile.name.saved");
  });

  it("holds Save until the new password meets every rule and the repeat matches", () => {
    view();
    fill("settings.profile.password.current", "Old-pass1!");
    fill("settings.profile.password.new", "weakpass");
    fill("settings.profile.password.repeat", "weakpass");
    expect(screen.getByRole("button", { name: "kit.saveBar.save" })).toBeDisabled();

    fill("settings.profile.password.new", STRONG);
    expect(screen.getByText("settings.profile.password.mismatch")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "kit.saveBar.save" })).toBeDisabled();

    fill("settings.profile.password.repeat", STRONG);
    expect(screen.getByRole("button", { name: "kit.saveBar.save" })).toBeEnabled();
  });

  it("ends the other places by default", async () => {
    view();
    expect(screen.getByRole("switch", { name: /settings.profile.password.endOthers/ })).toBeChecked();
    fill("settings.profile.password.current", "Old-pass1!");
    fill("settings.profile.password.new", STRONG);
    fill("settings.profile.password.repeat", STRONG);
    fireEvent.click(screen.getByRole("button", { name: "kit.saveBar.save" }));

    await waitFor(() => expect(changePassword).toHaveBeenCalledWith("Old-pass1!", STRONG, true));
    await waitFor(() => expect(screen.getByLabelText("settings.profile.password.current")).toHaveValue(""));
  });

  it("says a wrong current password under that field, and keeps what was typed", async () => {
    changePassword.mockRejectedValue(new ApiError("Your current password is not right", { status: 400, reason: "wrong_password" }));
    view();
    fill("settings.profile.password.current", "wrong");
    fill("settings.profile.password.new", STRONG);
    fill("settings.profile.password.repeat", STRONG);
    fireEvent.click(screen.getByRole("button", { name: "kit.saveBar.save" }));

    await waitFor(() => expect(screen.getByLabelText("settings.profile.password.current")).toHaveAttribute("aria-invalid", "true"));
    expect(screen.getByText("Your current password is not right")).toBeInTheDocument();
    expect(screen.getByLabelText("settings.profile.password.new")).toHaveValue(STRONG);
  });
});
