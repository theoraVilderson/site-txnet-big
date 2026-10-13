import { render } from "@testing-library/react";
import { createRef, type ComponentType, type RefObject } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLocale } from "@/context/LocaleContext";
import { Button, IconButton } from "./Button";
import { Input, NativeSelect, PasswordInput, Textarea } from "./Field";

/**
 * FE-1-g: on React 19 a kit control takes `ref` as a plain prop, so none of
 * them is a `forwardRef` wrapper any more — and every call site that hands
 * one a ref still gets the DOM node it asked for.
 */

vi.mock("@/context/LocaleContext", () => ({ useLocale: vi.fn() }));

beforeEach(() => {
  vi.mocked(useLocale).mockReturnValue({ lang: "en", t: (_ns: string, key: string) => key } as unknown as ReturnType<typeof useLocale>);
});

type Case = [name: string, component: unknown, node: () => { ref: RefObject<HTMLElement | null>; el: React.ReactElement }, tag: string];

const cases: Case[] = [
  ["Button", Button, () => { const ref = createRef<HTMLButtonElement>(); return { ref, el: <Button ref={ref}>ok</Button> }; }, "BUTTON"],
  ["IconButton", IconButton, () => { const ref = createRef<HTMLButtonElement>(); return { ref, el: <IconButton ref={ref} aria-label="x" icon={null} /> }; }, "BUTTON"],
  ["Input", Input, () => { const ref = createRef<HTMLInputElement>(); return { ref, el: <Input ref={ref} /> }; }, "INPUT"],
  ["Textarea", Textarea, () => { const ref = createRef<HTMLTextAreaElement>(); return { ref, el: <Textarea ref={ref} /> }; }, "TEXTAREA"],
  ["NativeSelect", NativeSelect, () => { const ref = createRef<HTMLSelectElement>(); return { ref, el: <NativeSelect ref={ref} /> }; }, "SELECT"],
  ["PasswordInput", PasswordInput, () => { const ref = createRef<HTMLInputElement>(); return { ref, el: <PasswordInput ref={ref} /> }; }, "INPUT"],
];

describe.each(cases)("%s", (_name, component, make, tag) => {
  it("is a plain function component, not a forwardRef wrapper", () => {
    expect(typeof (component as ComponentType)).toBe("function");
  });

  it("hands its ref the DOM node", () => {
    const { ref, el } = make();
    render(el);
    expect(ref.current?.tagName).toBe(tag);
  });
});
