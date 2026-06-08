import { describe, it, expect } from "vitest";
import { reduceHover, HOVER_INITIAL, type HoverState } from "./note-hover-machine";

const RECT = { x: 10, y: 20, width: 100, height: 16 };
const RECT2 = { x: 10, y: 40, width: 80, height: 16 };

describe("reduceHover", () => {
  it("enterHighlight from idle opens and cancels any close timer", () => {
    const r = reduceHover(HOVER_INITIAL, { type: "enterHighlight", annoId: "a1", rect: RECT });
    expect(r.next).toEqual({ annoId: "a1", anchorRect: RECT, open: true });
    expect(r.timer).toBe("cancel");
  });

  it("enterHighlight with same id while open is idempotent (keeps open, updates rect, cancels)", () => {
    const open: HoverState = { annoId: "a1", anchorRect: RECT, open: true };
    const r = reduceHover(open, { type: "enterHighlight", annoId: "a1", rect: RECT2 });
    expect(r.next).toEqual({ annoId: "a1", anchorRect: RECT2, open: true });
    expect(r.timer).toBe("cancel");
  });

  it("enterHighlight with different id while open switches to new id", () => {
    const open: HoverState = { annoId: "a1", anchorRect: RECT, open: true };
    const r = reduceHover(open, { type: "enterHighlight", annoId: "a2", rect: RECT2 });
    expect(r.next).toEqual({ annoId: "a2", anchorRect: RECT2, open: true });
    expect(r.timer).toBe("cancel");
  });

  it("leaveHighlight starts the close timer without changing state yet", () => {
    const open: HoverState = { annoId: "a1", anchorRect: RECT, open: true };
    const r = reduceHover(open, { type: "leaveHighlight" });
    expect(r.next).toEqual(open);
    expect(r.timer).toBe("start");
  });

  it("enterCard cancels the close timer", () => {
    const open: HoverState = { annoId: "a1", anchorRect: RECT, open: true };
    const r = reduceHover(open, { type: "enterCard" });
    expect(r.next).toEqual(open);
    expect(r.timer).toBe("cancel");
  });

  it("leaveCard starts the close timer", () => {
    const open: HoverState = { annoId: "a1", anchorRect: RECT, open: true };
    const r = reduceHover(open, { type: "leaveCard" });
    expect(r.next).toEqual(open);
    expect(r.timer).toBe("start");
  });

  it("closeNow resets to initial and cancels timer", () => {
    const open: HoverState = { annoId: "a1", anchorRect: RECT, open: true };
    const r = reduceHover(open, { type: "closeNow" });
    expect(r.next).toEqual(HOVER_INITIAL);
    expect(r.timer).toBe("cancel");
  });

  it("multi-fragment: leaveHighlight then enterHighlight same id stays open (no flicker)", () => {
    const open: HoverState = { annoId: "a1", anchorRect: RECT, open: true };
    const afterLeave = reduceHover(open, { type: "leaveHighlight" }).next;
    const afterReenter = reduceHover(afterLeave, {
      type: "enterHighlight",
      annoId: "a1",
      rect: RECT2,
    });
    expect(afterReenter.next.open).toBe(true);
    expect(afterReenter.next.annoId).toBe("a1");
    expect(afterReenter.timer).toBe("cancel");
  });
});
