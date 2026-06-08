import { describe, expect, it } from "vitest";
import { gestureStartedWithin } from "./use-drag-guard";

/**
 * 回归（书库 dialog 内拖拽误触发书籍拖拽）：portal 出去的浮层（dialog / 菜单）在 DOM 上不在
 * 宿主元素内，但其事件会经 React 合成事件系统冒泡回宿主——不该被判为「拖拽起手」。
 * gestureStartedWithin 用 DOM contains 校验事件 target 的真实物理归属来区分。
 */
describe("gestureStartedWithin", () => {
  // 最小 fake：贴近真实 Node.contains 语义——只认自身与登记的后代，contains(其它/null)===false。
  const makeNode = (descendants: object[] = []) => {
    const node = {
      contains: (t: unknown) => t === node || descendants.includes(t as object),
    } as unknown as HTMLElement;
    return node;
  };

  it("放行：手势起手于宿主自身", () => {
    const node = makeNode();
    expect(gestureStartedWithin(node, node as unknown as EventTarget)).toBe(true);
  });

  it("放行：手势起手于宿主 DOM 后代", () => {
    const child = {} as EventTarget;
    const node = makeNode([child]);
    expect(gestureStartedWithin(node, child)).toBe(true);
  });

  it("拦下：手势起手于 portal 浮层（宿主 DOM 之外）", () => {
    const portaled = {} as EventTarget; // dialog/菜单的 DOM 节点在 body，不在宿主内
    const node = makeNode([]);
    expect(gestureStartedWithin(node, portaled)).toBe(false);
  });

  it("拦下：宿主尚未挂载（node 为 null）", () => {
    expect(gestureStartedWithin(null, {} as EventTarget)).toBe(false);
  });

  it("拦下：事件无 target", () => {
    const node = makeNode();
    expect(gestureStartedWithin(node, null)).toBe(false);
  });
});
