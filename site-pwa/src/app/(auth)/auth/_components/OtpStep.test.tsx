import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OtpStep } from './OtpStep';
import { OTP_LENGTH } from '@/lib/otp';
import { useAuthUI } from '@auth/auth/_context/AuthUIContext';

// The provider pulls in the locale store and the whole i18n stack; the step
// only ever reads `t` and `isRtl`, so those are what the test supplies.
vi.mock('@auth/auth/_context/AuthUIContext', () => ({
  useAuthUI: vi.fn(),
}));

const t = {
  resendCodeIn: 'resend in',
  seconds: 'seconds',
  resendCode: 'resend code',
  editPhone: 'edit phone number',
};

function mockAuthUI(isRtl = true) {
  vi.mocked(useAuthUI).mockReturnValue({ isRtl, t } as ReturnType<
    typeof useAuthUI
  >);
}

function renderStep(props: Partial<Parameters<typeof OtpStep>[0]> = {}) {
  const onChange = vi.fn();
  const onResend = vi.fn();
  const onEditPhone = vi.fn();
  const utils = render(
    <OtpStep
      value=""
      onChange={onChange}
      timerSeconds={90}
      timerFormatted="01:30"
      onResend={onResend}
      onEditPhone={onEditPhone}
      delivery={null}
      {...props}
    />,
  );
  return { ...utils, onChange, onResend, onEditPhone };
}

const boxes = () => screen.getAllByRole('textbox');

beforeEach(() => {
  mockAuthUI();
});

describe('the code input', () => {
  it('renders exactly OTP_LENGTH boxes — the API rejects any other length', () => {
    renderStep();

    expect(boxes()).toHaveLength(OTP_LENGTH);
  });

  it('fills the boxes from `value`, left to right', () => {
    renderStep({ value: '1234' });

    expect(boxes().map((b) => (b as HTMLInputElement).value)).toEqual([
      '1', '2', '3', '4', '', '',
    ]);
  });

  it('reports each typed digit as the whole code so far', async () => {
    const user = userEvent.setup();
    const { onChange } = renderStep({ value: '12' });

    await user.type(boxes()[2], '3');

    expect(onChange).toHaveBeenCalledWith('123');
  });

  it('ignores a non-digit', async () => {
    const user = userEvent.setup();
    const { onChange } = renderStep();

    await user.type(boxes()[0], 'a');

    expect(onChange).not.toHaveBeenCalled();
  });

  it('spreads an autofilled code across the boxes instead of only box 0', async () => {
    const user = userEvent.setup();
    const { onChange } = renderStep();

    await user.click(boxes()[0]);
    await user.paste('123456');

    expect(onChange).toHaveBeenCalledWith('123456');
  });

  it('trims a pasted code longer than the input', async () => {
    const user = userEvent.setup();
    const { onChange } = renderStep();

    await user.click(boxes()[0]);
    await user.paste('1234567890');

    expect(onChange).toHaveBeenCalledWith('123456');
  });

  it('offers one-time-code autofill on the first box only', () => {
    renderStep();

    expect(boxes()[0]).toHaveAttribute('autocomplete', 'one-time-code');
    expect(boxes()[1]).toHaveAttribute('autocomplete', 'off');
  });
});

describe('the resend timer', () => {
  it('counts down instead of offering resend while the timer runs', () => {
    renderStep({ timerSeconds: 90, timerFormatted: '01:30' });

    expect(screen.getByText('01:30')).toBeInTheDocument();
    expect(screen.getByText(/resend in/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'resend code' }),
    ).not.toBeInTheDocument();
  });

  it('offers resend once the timer reaches zero', async () => {
    const user = userEvent.setup();
    const { onResend } = renderStep({ timerSeconds: 0, timerFormatted: '00:00' });

    expect(screen.queryByText(/resend in/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'resend code' }));

    expect(onResend).toHaveBeenCalledOnce();
  });
});

describe('going back to the phone number', () => {
  it('calls onEditPhone', async () => {
    const user = userEvent.setup();
    const { onEditPhone } = renderStep();

    await user.click(screen.getByRole('button', { name: /edit phone number/ }));

    expect(onEditPhone).toHaveBeenCalledOnce();
  });

  it('points the chevron back the way the language reads', () => {
    const { unmount } = renderStep();
    const rtlChevron = screen
      .getByRole('button', { name: /edit phone number/ })
      .querySelector('svg');
    expect(rtlChevron).not.toHaveClass('rotate-180');
    unmount();

    mockAuthUI(false);
    renderStep();
    const ltrChevron = screen
      .getByRole('button', { name: /edit phone number/ })
      .querySelector('svg');
    expect(ltrChevron).toHaveClass('rotate-180');
  });
});
