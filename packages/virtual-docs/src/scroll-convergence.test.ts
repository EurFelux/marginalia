import { afterEach, describe, expect, it, vi } from "vitest";
import { startScrollConvergence } from "./scroll-convergence";

afterEach(() => {
  vi.useRealTimers();
});

describe("startScrollConvergence", () => {
  it("retries until the target reports alignment", () => {
    vi.useFakeTimers();
    const attempt = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const onTimeout = vi.fn();
    const onSuccess = vi.fn();

    startScrollConvergence(attempt, onTimeout, { delayMs: 10, maxAttempts: 5, onSuccess });
    vi.advanceTimersByTime(30);

    expect(attempt).toHaveBeenCalledTimes(3);
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("does not accept transient alignment before the stability window", () => {
    vi.useFakeTimers();
    const attempt = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    const onSuccess = vi.fn();

    startScrollConvergence(attempt, vi.fn(), {
      delayMs: 10,
      maxAttempts: 10,
      minimumAttempts: 4,
      successesRequired: 2,
      onSuccess,
    });
    vi.advanceTimersByTime(100);

    expect(attempt).toHaveBeenCalledTimes(6);
    expect(onSuccess).toHaveBeenCalledOnce();
  });

  it("does not emit stale restoration commands after user navigation cancels it", () => {
    vi.useFakeTimers();
    const commands: string[] = [];
    const cancel = startScrollConvergence(
      () => {
        commands.push("restore");
        return false;
      },
      vi.fn(),
      {
        delayMs: 10,
        maxAttempts: 5,
      },
    );

    vi.advanceTimersByTime(10);
    cancel();
    commands.push("user-navigation");
    vi.advanceTimersByTime(100);

    expect(commands).toEqual(["restore", "user-navigation"]);
  });

  it("reports exhaustion once", () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    startScrollConvergence(() => false, onTimeout, { delayMs: 10, maxAttempts: 2 });
    vi.advanceTimersByTime(100);
    expect(onTimeout).toHaveBeenCalledOnce();
  });
});
