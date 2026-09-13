"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: readonly SelectOption[];
  /** Shown while `value` matches no option — an unchosen required field must not look chosen. */
  placeholder?: string;
  /** The accessible name when no `<label>` wraps the control. */
  ariaLabel?: string;
  id?: string;
  /** Draws the error border; the message itself is the caller's. */
  invalid?: boolean;
  disabled?: boolean;
  className?: string;
}

type Placement = { top: number; left: number; width: number; up: boolean };

/** Room the list wants below the button before it opens upwards instead. */
const LIST_MAX_PX = 240;

/**
 * The kit's select (F-102-d follow-up).
 *
 * A native `<select>` draws its option list with the browser's own widget, in
 * the browser's colours, and no CSS reaches it — so beside the panel's inputs
 * it looked like a default control, in the dark themes most of all. This is a
 * button and a listbox styled from the theme tokens.
 *
 * **What the native control gave for free is kept on purpose**: a listbox to
 * assistive technology (`aria-haspopup`, `aria-expanded`, `aria-selected`,
 * `aria-activedescendant`), arrows / Home / End / Enter / Space / Escape from
 * the keyboard, Tab closing it, and a click outside closing it.
 *
 * **The list is portaled to `document.body` with fixed coordinates**, for the
 * reason `GiftCodeModal` gives and one more: inside a scrolling modal an
 * absolutely-positioned list is clipped by the scroll container. It follows the
 * button on scroll and resize, and opens upwards when there is no room below.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  id,
  invalid = false,
  disabled = false,
  className = "",
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;

  const place = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const below = window.innerHeight - rect.bottom;
    const up = below < LIST_MAX_PX && rect.top > below;
    setPlacement({ top: up ? rect.top - 6 : rect.bottom + 6, left: rect.left, width: rect.width, up });
  }, []);

  const openList = () => {
    if (disabled || options.length === 0) return;
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  };

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const choose = (index: number) => {
    const option = options[index];
    if (option) onChange(option.value);
    close();
  };

  useLayoutEffect(() => {
    if (!open) return;
    place();
    listRef.current?.focus();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target) || listRef.current?.contains(target)) return;
      close(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("resize", place);
    // Capture, so a scroll inside the modal that holds the button moves the list too.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, open]);

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
      e.preventDefault();
      openList();
    }
  };

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const last = options.length - 1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => Math.min(last, i + 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => Math.max(0, i - 1));
        break;
      case "Home":
        e.preventDefault();
        setActive(0);
        break;
      case "End":
        e.preventDefault();
        setActive(last);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        choose(active);
        break;
      case "Escape":
        e.preventDefault();
        close();
        break;
      case "Tab":
        close(false);
        break;
    }
  };

  const border = invalid
    ? "border-[var(--error-color)]"
    : open
      ? "border-[var(--accent-primary)] ring-2 ring-[var(--accent-glow)]"
      : "border-card-border hover:border-[var(--accent-primary)]";

  return (
    <>
      <button
        ref={buttonRef}
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel ? `${ariaLabel}: ${selected?.label ?? placeholder ?? ""}` : undefined}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onButtonKey}
        className={`flex w-full items-center justify-between gap-2 rounded-xl border bg-[var(--bg-inner)] px-3 py-2 text-start text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-glow)] disabled:cursor-not-allowed disabled:opacity-60 ${border} ${className}`}
      >
        <span className={`truncate ${selected ? "text-[var(--text-input)]" : "text-[var(--text-label)]"}`}>
          {selected?.label ?? placeholder ?? " "}
        </span>
        <ChevronDown
          size={16}
          aria-hidden
          className={`shrink-0 text-[var(--text-secondary)] transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            tabIndex={-1}
            aria-activedescendant={`${baseId}-opt-${active}`}
            onKeyDown={onListKey}
            style={
              placement
                ? {
                    left: placement.left,
                    width: placement.width,
                    ...(placement.up ? { bottom: window.innerHeight - placement.top } : { top: placement.top }),
                  }
                : undefined
            }
            className="fixed z-[60] max-h-60 min-w-[10rem] overflow-y-auto rounded-2xl border border-card-border bg-[var(--bg-inner)] p-1 shadow-[0_12px_32px_var(--card-shadow)] focus:outline-none"
          >
            {options.map((option, index) => {
              const isSelected = index === selectedIndex;
              return (
                <li
                  key={option.value}
                  id={`${baseId}-opt-${index}`}
                  data-index={index}
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(index)}
                  className={`flex cursor-pointer items-center justify-between gap-2 rounded-xl px-3 py-2 text-sm transition-colors ${
                    index === active ? "bg-[var(--leaf-bg)]" : ""
                  } ${isSelected ? "font-bold text-[var(--accent-primary)]" : "text-[var(--text-input)]"}`}
                >
                  <span className="truncate">{option.label}</span>
                  {isSelected && <Check size={14} aria-hidden className="shrink-0" />}
                </li>
              );
            })}
          </ul>,
          document.body,
        )}
    </>
  );
}
