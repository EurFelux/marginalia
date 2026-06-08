import { describe, expect, it } from "vitest";
import { isSubmitEnter } from "./keyboard";

/** 仅构造守卫读取的字段；与 React.KeyboardEvent 结构兼容。 */
const ev = (o: { key?: string; shiftKey?: boolean; isComposing?: boolean }) => ({
  key: o.key ?? "Enter",
  shiftKey: o.shiftKey ?? false,
  nativeEvent: { isComposing: o.isComposing ?? false },
});

describe("isSubmitEnter", () => {
  it("裸 Enter → 提交", () => {
    expect(isSubmitEnter(ev({}))).toBe(true);
  });

  it("Shift+Enter → 换行，不提交", () => {
    expect(isSubmitEnter(ev({ shiftKey: true }))).toBe(false);
  });

  it("IME 组字中的 Enter（候选词上屏）→ 不提交", () => {
    expect(isSubmitEnter(ev({ isComposing: true }))).toBe(false);
  });

  it("IME 组字中的 Shift+Enter → 不提交", () => {
    expect(isSubmitEnter(ev({ shiftKey: true, isComposing: true }))).toBe(false);
  });

  it("非 Enter 键 → 不处理", () => {
    expect(isSubmitEnter(ev({ key: "a" }))).toBe(false);
  });
});
