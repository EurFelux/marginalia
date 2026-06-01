import { create } from "zustand";
import type { Chip } from "@shared/chat";
import type { ReaderPrefs, SelectionInfo } from "@renderer/types";

interface ReaderState {
  view: "library" | "reader";
  currentBookId: string | null;
  currentChapterId: string | null;
  selection: SelectionInfo | null;
  prefs: ReaderPrefs;
  activeConversationId: string | null;
  panelOpen: boolean;
  sidebarOpen: boolean;
  draftChips: Chip[];
  draftText: string;
}

interface ReaderActions {
  openBook: (bookId: string, chapterId?: string | null) => void;
  backToLibrary: () => void;
  setCurrentChapter: (chapterId: string) => void;
  setSelection: (selection: SelectionInfo | null) => void;
  setActiveConversation: (id: string | null) => void;
  updatePrefs: (patch: Partial<ReaderPrefs>) => void;
  setPanelOpen: (open: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  setDraftText: (text: string) => void;
  setDraftChips: (chips: Chip[]) => void;
}

export const READER_INITIAL: ReaderState = {
  view: "library",
  currentBookId: null,
  currentChapterId: null,
  selection: null,
  prefs: { fontScale: 1, lineHeight: 1.9, maxWidth: 640 },
  activeConversationId: null,
  panelOpen: false,
  sidebarOpen: true,
  draftChips: [],
  draftText: "",
};

export const useReaderStore = create<ReaderState & ReaderActions>((set) => ({
  ...READER_INITIAL,
  openBook: (bookId, chapterId = null) =>
    set({
      view: "reader",
      currentBookId: bookId,
      currentChapterId: chapterId,
      activeConversationId: null,
    }),
  backToLibrary: () => set({ view: "library" }),
  setCurrentChapter: (currentChapterId) => set({ currentChapterId }),
  setSelection: (selection) => set({ selection }),
  setActiveConversation: (activeConversationId) => set({ activeConversationId }),
  updatePrefs: (patch) => set((s) => ({ prefs: { ...s.prefs, ...patch } })),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setDraftText: (draftText) => set({ draftText }),
  setDraftChips: (draftChips) => set({ draftChips }),
}));
