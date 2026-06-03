import { beforeEach, describe, expect, it } from "vitest";
import { useThemeStore } from "@renderer/store/theme-store";

beforeEach(() => useThemeStore.setState({ colorMode: "system", resolvedTheme: "light" }));

describe("theme-store", () => {
  it("setColorMode('dark') sets colorMode and resolves dark", () => {
    useThemeStore.getState().setColorMode("dark");
    expect(useThemeStore.getState().colorMode).toBe("dark");
    expect(useThemeStore.getState().resolvedTheme).toBe("dark");
  });

  it("setColorMode('light') resolves light", () => {
    useThemeStore.getState().setColorMode("light");
    expect(useThemeStore.getState().resolvedTheme).toBe("light");
  });

  it("setColorMode('system') resolves via system (no window → light)", () => {
    useThemeStore.getState().setColorMode("system");
    expect(useThemeStore.getState().colorMode).toBe("system");
    expect(useThemeStore.getState().resolvedTheme).toBe("light");
  });

  it("syncSystem re-resolves from current colorMode", () => {
    useThemeStore.setState({ colorMode: "dark", resolvedTheme: "light" });
    useThemeStore.getState().syncSystem();
    expect(useThemeStore.getState().resolvedTheme).toBe("dark");
  });
});
