import { create } from "zustand";
import type { AnnotationStyle } from "@shared/annotations";
import type { ReaderPrefs } from "@renderer/types";
import { persistPreference } from "@renderer/store/persist-preference";

interface ReaderState {
  prefs: ReaderPrefs;
  sidebarOpen: boolean;
  /** 上次选用的高亮样式；选「高亮标记」时直接套用（Apple Books 式记忆，会话内）。 */
  lastHighlightStyle: AnnotationStyle;
}

interface ReaderActions {
  updatePrefs: (patch: Partial<ReaderPrefs>) => void;
  setSidebarOpen: (open: boolean) => void;
  setLastHighlightStyle: (style: AnnotationStyle) => void;
}

export const READER_INITIAL: ReaderState = {
  prefs: { fontScale: 1, lineHeight: 1.9, maxWidth: 640 },
  sidebarOpen: true,
  lastHighlightStyle: "yellow",
};

export const useReaderStore = create<ReaderState & ReaderActions>((set) => ({
  ...READER_INITIAL,
  updatePrefs: (patch) =>
    set((s) => {
      const prefs = { ...s.prefs, ...patch };
      persistPreference({ key: "readerPrefs", value: prefs });
      return { prefs };
    }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setLastHighlightStyle: (lastHighlightStyle) => {
    persistPreference({ key: "lastHighlightStyle", value: lastHighlightStyle });
    set({ lastHighlightStyle });
  },
}));
