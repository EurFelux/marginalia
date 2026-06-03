import { beforeEach, describe, expect, it } from "vitest";
import { useAnnotationStore, ANNOTATION_INITIAL } from "@renderer/store/annotation-store";

beforeEach(() => useAnnotationStore.setState(ANNOTATION_INITIAL));

describe("annotation-store", () => {
  it("setSelection stores selection", () => {
    useAnnotationStore.getState().setSelection({ selectionText: "x" } as never);
    expect(useAnnotationStore.getState().selection).not.toBeNull();
  });
  it("openStyleBar / closeStyleBar toggle", () => {
    useAnnotationStore.getState().openStyleBar({
      rect: { x: 0, y: 0, width: 0, height: 0 },
      target: { type: "create" },
    });
    expect(useAnnotationStore.getState().styleBar).not.toBeNull();
    useAnnotationStore.getState().closeStyleBar();
    expect(useAnnotationStore.getState().styleBar).toBeNull();
  });
  it("requestScroll bumps nonce each call", () => {
    useAnnotationStore.getState().requestScroll("cfi-a");
    const n1 = useAnnotationStore.getState().scrollCommand?.nonce;
    useAnnotationStore.getState().requestScroll("cfi-b");
    const cmd = useAnnotationStore.getState().scrollCommand;
    expect(cmd?.cfi).toBe("cfi-b");
    expect(cmd?.nonce).toBe((n1 ?? 0) + 1);
  });
});
