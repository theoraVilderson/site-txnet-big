import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OTPInput } from './OTPInput';

/**
 * 2026-10-08, register on panel.barghgho.ir: a pasted code did nothing and a
 * finished code waited for the button. What breaks silently here:
 *  - a code in Persian or Arabic digits (an SMS read on a Persian phone, a
 *    Persian keyboard) is thrown away, because only `0-9` was kept;
 *  - the OS's one-time-code autofill writes the whole code into one box, and
 *    a one-character box kept only its last digit;
 *  - the last digit, typed or pasted, submits the form — once, with the code.
 */
function Harness({ onSubmit, initial = '' }: { onSubmit: (code: string) => void; initial?: string }) {
  const [code, setCode] = useState(initial);
  return (
    <form onSubmit={(e) => { e.preventDefault(); onSubmit(code); }}>
      <OTPInput length={6} value={code} onChange={setCode} />
    </form>
  );
}

const boxes = () => screen.getAllByRole('textbox') as HTMLInputElement[];
const shown = () => boxes().map((b) => b.value).join('');

function paste(target: HTMLInputElement, text: string) {
  fireEvent.paste(target, { clipboardData: { getData: () => text } });
}

describe('OTPInput', () => {
  it('takes a pasted code written in Persian digits, and submits it', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    paste(boxes()[0], '۵۴۳۱۰۰');
    expect(shown()).toBe('543100');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('543100');
  });

  it('takes Arabic-Indic digits and the words around a code', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    paste(boxes()[2], 'کد: ٥٤٣١٠٠');
    expect(onSubmit).toHaveBeenCalledWith('543100');
  });

  it('spreads a whole code autofilled into one box', () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    fireEvent.change(boxes()[0], { target: { value: '543100' } });
    expect(shown()).toBe('543100');
    expect(onSubmit).toHaveBeenCalledWith('543100');
  });

  it('submits when the last digit is typed, and not before', async () => {
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} />);
    await userEvent.click(boxes()[0]);
    await userEvent.keyboard('۵۴۳۱۰');
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.keyboard('0');
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('543100');
  });

  it('does not submit while a full code is being typed over', async () => {
    // The code before stayed in the boxes; the first new digit kept it at six,
    // and the half-old code went off as soon as it was typed.
    const onSubmit = vi.fn();
    render(<Harness onSubmit={onSubmit} initial="543100" />);
    await userEvent.click(boxes()[0]);
    await userEvent.keyboard('8');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('ignores a key that is not a digit', async () => {
    render(<Harness onSubmit={vi.fn()} />);
    await userEvent.click(boxes()[0]);
    await userEvent.keyboard('a');
    expect(shown()).toBe('');
  });
});
