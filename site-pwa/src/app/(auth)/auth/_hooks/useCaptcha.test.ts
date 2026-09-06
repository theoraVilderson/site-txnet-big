import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useCaptcha } from './useCaptcha';
import { authApi } from '@/lib/auth-api';

vi.mock('@/lib/auth-api', () => ({
  authApi: {
    captchaChallenge: vi.fn(),
    captchaVerify: vi.fn(),
  },
}));

const challenge = vi.mocked(authApi.captchaChallenge);
const verify = vi.mocked(authApi.captchaVerify);

/** A promise plus the handles to settle it from the test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  challenge.mockResolvedValue({ challengeId: 'ch_1' });
  verify.mockResolvedValue({ token: 'cap_1', expiresIn: 120 });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('the happy path', () => {
  it('starts unverified and fetches a challenge on mount', async () => {
    const { result } = renderHook(() => useCaptcha());

    expect(result.current.verified).toBe(false);
    expect(result.current.token).toBeNull();
    await waitFor(() => expect(challenge).toHaveBeenCalledTimes(1));
  });

  it('exchanges a completed slide for a pass', async () => {
    const { result } = renderHook(() => useCaptcha());
    await waitFor(() => expect(challenge).toHaveBeenCalled());

    await act(async () => {
      await result.current.complete();
    });

    expect(verify).toHaveBeenCalledWith('ch_1');
    expect(result.current.verified).toBe(true);
    expect(result.current.token).toBe('cap_1');
  });
});

describe('a slide that beats the challenge request', () => {
  it('queues instead of silently doing nothing', async () => {
    // The mount fetch is still in flight when the user slides — the bug this
    // hook's `challengeRequestRef` exists to prevent (the thumb used to snap
    // back and only work "after waiting a second").
    const pending = deferred<{ challengeId: string }>();
    challenge.mockReturnValueOnce(pending.promise);

    const { result } = renderHook(() => useCaptcha());

    let completed!: Promise<void>;
    act(() => {
      completed = result.current.complete();
    });
    expect(verify).not.toHaveBeenCalled();

    await act(async () => {
      pending.resolve({ challengeId: 'ch_late' });
      await completed;
    });

    expect(verify).toHaveBeenCalledExactlyOnceWith('ch_late');
    expect(result.current.verified).toBe(true);
  });
});

describe('failures', () => {
  it('retries the challenge once when the mount fetch failed', async () => {
    challenge.mockRejectedValueOnce(new Error('offline'));

    const { result } = renderHook(() => useCaptcha());
    await waitFor(() => expect(challenge).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.complete();
    });

    expect(challenge).toHaveBeenCalledTimes(2);
    expect(verify).toHaveBeenCalledWith('ch_1');
    expect(result.current.verified).toBe(true);
  });

  it('gives up quietly when the retry fails too', async () => {
    challenge.mockRejectedValue(new Error('offline'));

    const { result } = renderHook(() => useCaptcha());
    await waitFor(() => expect(challenge).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.complete();
    });

    expect(verify).not.toHaveBeenCalled();
    expect(result.current.verified).toBe(false);
    expect(result.current.token).toBeNull();
  });

  it('stays unverified and asks for a fresh challenge when verify is rejected', async () => {
    verify.mockRejectedValue(new Error('slide did not match'));

    const { result } = renderHook(() => useCaptcha());
    await waitFor(() => expect(challenge).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.complete();
    });

    expect(result.current.verified).toBe(false);
    expect(result.current.token).toBeNull();
    expect(challenge).toHaveBeenCalledTimes(2);
  });
});

describe('the pass expiring', () => {
  it('drops back to unverified when the server-side TTL runs out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    verify.mockResolvedValue({ token: 'cap_1', expiresIn: 120 });

    const { result } = renderHook(() => useCaptcha());
    await vi.waitFor(() => expect(challenge).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.complete();
    });
    expect(result.current.verified).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(result.current.verified).toBe(false);
    expect(result.current.token).toBeNull();
    expect(challenge).toHaveBeenCalledTimes(2);
  });

  it('keeps the pass until the TTL is actually up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const { result } = renderHook(() => useCaptcha());
    await vi.waitFor(() => expect(challenge).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.complete();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(119_000);
    });

    expect(result.current.verified).toBe(true);
    expect(result.current.token).toBe('cap_1');
  });

  it('does not fire the expiry timer after unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const { result, unmount } = renderHook(() => useCaptcha());
    await vi.waitFor(() => expect(challenge).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.complete();
    });

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(challenge).toHaveBeenCalledTimes(1);
  });
});

describe('spend()', () => {
  it('drops the pass the moment it is handed to an endpoint', async () => {
    // The server burns a pass on use, so a second submit needs a second slide.
    const { result } = renderHook(() => useCaptcha());
    await waitFor(() => expect(challenge).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.complete();
    });

    await act(async () => {
      result.current.spend();
    });

    expect(result.current.verified).toBe(false);
    expect(result.current.token).toBeNull();
    expect(challenge).toHaveBeenCalledTimes(2);
  });

  it('leaves the widget usable again: a second slide verifies against the new challenge', async () => {
    challenge
      .mockResolvedValueOnce({ challengeId: 'ch_1' })
      .mockResolvedValueOnce({ challengeId: 'ch_2' });
    verify
      .mockResolvedValueOnce({ token: 'cap_1', expiresIn: 120 })
      .mockResolvedValueOnce({ token: 'cap_2', expiresIn: 120 });

    const { result } = renderHook(() => useCaptcha());
    await waitFor(() => expect(challenge).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.complete();
    });
    await act(async () => {
      result.current.spend();
    });

    await act(async () => {
      await result.current.complete();
    });

    expect(verify).toHaveBeenLastCalledWith('ch_2');
    expect(result.current.token).toBe('cap_2');
    expect(result.current.verified).toBe(true);
  });
});
