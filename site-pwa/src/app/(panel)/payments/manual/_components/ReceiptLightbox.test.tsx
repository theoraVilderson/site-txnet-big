import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ReceiptLightbox } from "./ReceiptLightbox";

/**
 * The receipt link is signed for five minutes (F-033-c) and the dialog asks for
 * the image only when opened, so a list open longer than that held a dead link
 * and told the reviewer to reload the page. A link past its expiry is renewed
 * instead (`onExpired` re-reads the list); a link still in date that fails is a
 * real failure and says so — never a renewal loop.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: () => ({ t: (_ns: string, key: string) => key, lang: "en" }) }));

const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

function open(expiresAt: string) {
  const onExpired = vi.fn();
  render(<ReceiptLightbox url="/r.png" expiresAt={expiresAt} open onClose={() => {}} onExpired={onExpired} />);
  fireEvent.error(screen.getByRole("img"));
  return onExpired;
}

describe("ReceiptLightbox — an expired link", () => {
  it("asks for a fresh link instead of telling the reviewer to reload", () => {
    const onExpired = open(at(-1000));
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the failure when a link still in date does not load", () => {
    const onExpired = open(at(60_000));
    expect(onExpired).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
  });
});
