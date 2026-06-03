import { beforeEach, describe, expect, it } from "vitest";
import { useReaderStore, READER_INITIAL } from "@renderer/store/reader-store";

// zustand v5: replace=true 会覆盖 actions；用合并式重置只覆盖 state 字段
beforeEach(() => {
  useReaderStore.setState(READER_INITIAL);
});

describe("reader-store", () => {
  it("updatePrefs merges", () => {
    useReaderStore.getState().updatePrefs({ fontScale: 1.2 });
    expect(useReaderStore.getState().prefs.fontScale).toBe(1.2);
    expect(useReaderStore.getState().prefs.maxWidth).toBe(READER_INITIAL.prefs.maxWidth);
  });
});
