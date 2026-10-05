import { cloneElement, type ReactElement, type Ref, type RefObject } from "react";

type Props = Record<string, unknown> & { ref?: Ref<HTMLElement> };

/**
 * The caller's trigger element with the overlay's props merged in: its own
 * handlers still run, and its own ref still receives the node (React 19 keeps
 * `ref` on props).
 */
export function withTrigger(trigger: ReactElement, ref: RefObject<HTMLElement | null>, extra: Props): ReactElement {
  const own = trigger.props as Props;
  const merged: Props = { ...extra };
  for (const [key, handler] of Object.entries(extra)) {
    const mine = own[key];
    if (key.startsWith("on") && typeof handler === "function" && typeof mine === "function") {
      merged[key] = (...args: unknown[]) => {
        (mine as (...a: unknown[]) => void)(...args);
        (handler as (...a: unknown[]) => void)(...args);
      };
    }
  }
  merged.ref = (node: HTMLElement | null) => {
    ref.current = node;
    const theirs = own.ref;
    if (typeof theirs === "function") theirs(node);
    else if (theirs && typeof theirs === "object") (theirs as { current: HTMLElement | null }).current = node;
  };
  return cloneElement(trigger, merged);
}
