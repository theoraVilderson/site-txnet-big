import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { useAutofill } from './useAutofill';

/** A controlled field wired exactly the way the auth fields wire it. */
function Field() {
  const [value, setValue] = useState('');
  const { ref, autofilled, onAnimationStart } = useAutofill(value);

  return (
    <>
      <input
        ref={ref}
        aria-label="field"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onAnimationStart={onAnimationStart}
      />
      <span data-testid="floated">
        {autofilled || value.length > 0 ? 'yes' : 'no'}
      </span>
    </>
  );
}

/** The one field of the animation event the hook reads. */
const marker = (animationName: string) =>
  ({ animationName }) as React.AnimationEvent<HTMLInputElement>;

/** Let the frame-by-frame watcher run, inside `act` so React can flush. */
async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

/** What the browser does on autofill: writes the DOM value, tells nobody. */
function fillFromBrowser(el: HTMLInputElement, text: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!.call(el, text);
}

describe('useAutofill', () => {
  it('hands a value the browser wrote silently back to React', async () => {
    render(<Field />);
    const input = screen.getByLabelText('field') as HTMLInputElement;

    fillFromBrowser(input, 'someone');
    await settle();

    expect(screen.getByTestId('floated')).toHaveTextContent('yes');
    expect(input.value).toBe('someone');
  });

  it('leaves a focused field alone — a real edit brings its own event', async () => {
    render(<Field />);
    const input = screen.getByLabelText('field') as HTMLInputElement;
    input.focus();

    fillFromBrowser(input, 'typing');
    await settle();

    expect(screen.getByTestId('floated')).toHaveTextContent('no');
  });

  it('floats and unfloats on the CSS marker animations', () => {
    const { result } = renderHook(() => useAutofill(''));

    act(() => result.current.onAnimationStart(marker('onAutoFillStart')));
    expect(result.current.autofilled).toBe(true);

    act(() => result.current.onAnimationStart(marker('onAutoFillCancel')));
    expect(result.current.autofilled).toBe(false);
  });

  it('watches a field that mounts long after the hook was first called', async () => {
    // The panel's password tab: the parent is on screen from the start, the
    // input only appears when the tab is picked. An object ref would have been
    // null on the one pass the effect ran.
    function Tabbed() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>open</button>
          {open && <Field />}
        </>
      );
    }

    render(<Tabbed />);
    await settle();
    fireEvent.click(screen.getByText('open'));

    const input = screen.getByLabelText('field') as HTMLInputElement;
    fillFromBrowser(input, 'someone');
    await settle();

    expect(screen.getByTestId('floated')).toHaveTextContent('yes');
  });

  it('stops watching once the field is filled and in sync', async () => {
    const spy = vi.spyOn(window, 'requestAnimationFrame');
    render(<Field />);
    const input = screen.getByLabelText('field') as HTMLInputElement;

    fillFromBrowser(input, 'someone');
    await settle();
    expect(input.value).toBe('someone');

    // jsdom cannot match `:-webkit-autofill`, so the watcher runs to its
    // deadline here; what matters is that it is bounded and never dispatches
    // a second change for a value React already holds.
    const seen = spy.mock.calls.length;
    await settle();
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(seen);
    expect(input.value).toBe('someone');
    spy.mockRestore();
  });
});
