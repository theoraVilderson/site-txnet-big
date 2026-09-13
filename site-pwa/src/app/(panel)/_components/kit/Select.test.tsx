import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Select } from "./Select";

/**
 * The kit's select (F-102-d follow-up). A native `<select>` cannot be styled —
 * its option list is drawn by the browser, in the browser's colours — so the
 * panel's forms looked unstyled beside every other control. The replacement has
 * to keep what the native one gave for free, and that is what this asserts:
 *
 * - it is still a listbox to assistive technology (`aria-expanded`,
 *   `role="option"`, `aria-selected`);
 * - it works from the keyboard: arrows move, Enter chooses, Escape closes
 *   without changing anything;
 * - an empty value shows the placeholder rather than the first option, so a
 *   required field that was never chosen does not look chosen.
 */

const OPTIONS = [
  { value: "zarinpal", label: "Zarinpal" },
  { value: "idpay", label: "IDPay" },
  { value: "stripe", label: "Stripe" },
];

describe("Select", () => {
  it("shows the placeholder for an empty value and the chosen label otherwise", () => {
    const { rerender } = render(<Select value="" onChange={() => {}} options={OPTIONS} placeholder="Choose" ariaLabel="Provider" />);
    expect(screen.getByRole("button", { name: /Provider/ })).toHaveTextContent("Choose");

    rerender(<Select value="idpay" onChange={() => {}} options={OPTIONS} placeholder="Choose" ariaLabel="Provider" />);
    expect(screen.getByRole("button", { name: /Provider/ })).toHaveTextContent("IDPay");
  });

  it("opens a listbox that marks the selected option", () => {
    render(<Select value="idpay" onChange={() => {}} options={OPTIONS} ariaLabel="Provider" />);
    const button = screen.getByRole("button", { name: /Provider/ });

    fireEvent.click(button);

    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "IDPay" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("option", { name: "Zarinpal" })).toHaveAttribute("aria-selected", "false");
  });

  it("chooses with a click and closes", () => {
    const onChange = vi.fn();
    render(<Select value="" onChange={onChange} options={OPTIONS} ariaLabel="Provider" />);

    fireEvent.click(screen.getByRole("button", { name: /Provider/ }));
    fireEvent.click(screen.getByRole("option", { name: "Stripe" }));

    expect(onChange).toHaveBeenCalledWith("stripe");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("moves with the arrows, chooses with Enter, and Escape changes nothing", () => {
    const onChange = vi.fn();
    render(<Select value="zarinpal" onChange={onChange} options={OPTIONS} ariaLabel="Provider" />);
    const button = screen.getByRole("button", { name: /Provider/ });

    fireEvent.keyDown(button, { key: "ArrowDown" });
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.keyDown(button, { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByRole("listbox"), { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("idpay");
  });
});
