import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { AnimatedNumber } from "./AnimatedNumber";
import { Button, IconButton } from "./Button";
import { Field, Input, PasswordInput, Textarea } from "./Field";
import { RadioCards, SegmentedControl } from "./choice";
import { Select } from "./Select";
import { StatusPill } from "./StatusPill";
import { Checkbox, Toggle } from "./Toggle";

/**
 * The kit's form and display primitives (UX-1-c, `contract.ux.md` K3–K6).
 * What every page that moves onto them inherits, so what this asserts is the
 * accessible contract, not the classes:
 *
 * - a loading `Button` keeps its label (and so its accessible name and its
 *   width), is disabled and says it is busy — a double submit is impossible
 *   without each page remembering to block it;
 * - a `Field`'s error *replaces* its hint and is what the control is described
 *   by, with `aria-invalid` set — for every control the Field can hold,
 *   including the kit `Select`, which is a button and not an input;
 * - a counter appears only with `maxLength`;
 * - the choice controls are radio groups with arrow keys;
 * - `AnimatedNumber` reads as its final value to a screen reader from the
 *   first frame, whatever the count-up is showing.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));

beforeEach(() => {
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t: (_ns: string, key: string) => key } as unknown as ReturnType<typeof useLocale>);
});

describe("Button", () => {
  it("keeps its label while loading, and is disabled and busy", () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("is a plain button, not a submit, unless asked", () => {
    render(<Button>Go</Button>);
    expect(screen.getByRole("button", { name: "Go" })).toHaveAttribute("type", "button");
  });

  it("an IconButton is named by its aria-label", () => {
    render(<IconButton aria-label="Close" icon={<svg />} />);
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });
});

describe("Field", () => {
  it("describes the control by its hint, then by its error instead", () => {
    const { rerender } = render(
      <Field label="Email" hint="We never share it">
        <Input value="" onChange={() => {}} />
      </Field>,
    );
    const input = screen.getByLabelText("Email");
    expect(input).toHaveAccessibleDescription("We never share it");
    expect(input).not.toHaveAttribute("aria-invalid");

    rerender(
      <Field label="Email" hint="We never share it" error="Not an email">
        <Input value="x" onChange={() => {}} />
      </Field>,
    );
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Not an email");
    expect(screen.queryByText("We never share it")).not.toBeInTheDocument();
  });

  it("shows a counter only with maxLength", () => {
    const { rerender } = render(
      <Field label="Subject">
        <Textarea value="hello" onChange={() => {}} />
      </Field>,
    );
    expect(screen.queryByText("5/40")).not.toBeInTheDocument();

    rerender(
      <Field label="Subject">
        <Textarea value="hello" onChange={() => {}} maxLength={40} />
      </Field>,
    );
    expect(screen.getByText("5/40")).toBeInTheDocument();
  });

  it("wires the kit Select the same way", () => {
    render(
      <Field label="Provider" error="Pick one">
        <Select value="" onChange={() => {}} options={[{ value: "a", label: "A" }]} placeholder="Choose" />
      </Field>,
    );
    const button = screen.getByLabelText("Provider");
    expect(button).toHaveAttribute("aria-invalid", "true");
    expect(button).toHaveAccessibleDescription("Pick one");
  });

  it("a PasswordInput shows and hides what was typed", () => {
    render(
      <Field label="Password">
        <PasswordInput value="s3cret" onChange={() => {}} />
      </Field>,
    );
    const input = screen.getByLabelText("Password");
    expect(input).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "kit.password.show" }));
    expect(input).toHaveAttribute("type", "text");
  });
});

describe("choice controls", () => {
  it("Toggle is a switch and Checkbox a checkbox", () => {
    const onToggle = vi.fn();
    const onCheck = vi.fn();
    render(
      <>
        <Toggle checked={false} onChange={onToggle} label="Active" />
        <Checkbox checked onChange={onCheck} label="Agree" />
      </>,
    );
    fireEvent.click(screen.getByRole("switch", { name: /Active/ }));
    expect(onToggle).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Agree" }));
    expect(onCheck).toHaveBeenCalledWith(false);
  });

  it.each([
    ["SegmentedControl", SegmentedControl],
    ["RadioCards", RadioCards],
  ] as const)("%s is a radio group the arrow keys move through", (_name, Control) => {
    const onChange = vi.fn();
    render(
      <Control
        ariaLabel="Period"
        value="day"
        onChange={onChange}
        options={[
          { value: "day", label: "Day" },
          { value: "week", label: "Week" },
        ]}
      />,
    );
    expect(screen.getByRole("radiogroup", { name: "Period" })).toBeInTheDocument();
    const day = screen.getByRole("radio", { name: /Day/ });
    expect(day).toHaveAttribute("aria-checked", "true");
    expect(day).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("radio", { name: /Week/ })).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(day, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledWith("week");
  });
});

describe("display", () => {
  it("StatusPill carries its tone", () => {
    render(<StatusPill tone="warning">Expiring</StatusPill>);
    expect(screen.getByText("Expiring").closest("[data-tone]")).toHaveAttribute("data-tone", "warning");
  });

  it("AnimatedNumber reads as the final value from the first frame", () => {
    render(<AnimatedNumber value={1250} format={(n) => `$${Math.round(n)}`} />);
    expect(screen.getByText("$1250", { selector: ".sr-only" })).toBeInTheDocument();
  });
});
