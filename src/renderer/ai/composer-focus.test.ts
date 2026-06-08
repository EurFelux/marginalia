import { afterEach, describe, expect, it, vi } from "vitest";
import { registerComposerFocus, focusComposer } from "@renderer/ai/composer-focus";

afterEach(() => registerComposerFocus(null));

describe("composer-focus registry", () => {
  it("focusComposer invokes the registered focuser", () => {
    const spy = vi.fn();
    registerComposerFocus(spy);
    focusComposer();
    expect(spy).toHaveBeenCalledOnce();
  });

  it("focusComposer is a safe no-op when nothing is registered", () => {
    registerComposerFocus(null);
    expect(() => focusComposer()).not.toThrow();
  });

  it("registerComposerFocus(null) deregisters the previous focuser", () => {
    const spy = vi.fn();
    registerComposerFocus(spy);
    registerComposerFocus(null);
    focusComposer();
    expect(spy).not.toHaveBeenCalled();
  });
});
