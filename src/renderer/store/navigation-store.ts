import { create } from "zustand";
import type { ReadingContext } from "@shared/chat";
import { useChatStore } from "@renderer/store/chat-store";

interface NavigationState {
  view: "library" | "stats" | "book";
  currentBookId: string | null;
  bookMode: "auto" | "reference";
  currentChapterId: string | null;
  readingContext: ReadingContext | null;
  /** 0–1 阅读进度（header 面包屑显示用；#48）。与 readingContext 分离——后者是 AI 聊天契约。 */
  readingPercent: number | null;
}
interface NavigationActions {
  openBook: (bookId: string, chapterId?: string | null) => void;
  openBookReference: (bookId: string) => void;
  backToLibrary: () => void;
  showLibrary: () => void;
  showStats: () => void;
  setCurrentChapter: (chapterId: string) => void;
  setReadingContext: (readingContext: ReadingContext | null) => void;
  setReadingPercent: (readingPercent: number | null) => void;
}

export const NAVIGATION_INITIAL: NavigationState = {
  view: "library",
  currentBookId: null,
  bookMode: "auto",
  currentChapterId: null,
  readingContext: null,
  readingPercent: null,
};

export const useNavigationStore = create<NavigationState & NavigationActions>((set) => ({
  ...NAVIGATION_INITIAL,
  openBook: (bookId, chapterId = null) => {
    set({
      view: "book",
      currentBookId: bookId,
      bookMode: "auto",
      currentChapterId: chapterId,
      readingContext: null,
      readingPercent: null,
    });
    useChatStore.getState().resetForBookSwitch(); // 切书清残留 openCommand；active 由 activeByBook 派生恢复
  },
  openBookReference: (bookId) => {
    set({
      view: "book",
      currentBookId: bookId,
      bookMode: "reference",
      readingContext: null,
      readingPercent: null,
    });
    useChatStore.getState().resetForBookSwitch();
  },
  // 仅切回 library；currentBookId/currentChapterId 有意保留（App 按 view 守卫，library 下不读这些 id）
  backToLibrary: () => set({ view: "library" }),
  showLibrary: () => set({ view: "library" }),
  showStats: () => set({ view: "stats" }),
  setCurrentChapter: (currentChapterId) => set({ currentChapterId }),
  setReadingContext: (readingContext) => set({ readingContext }),
  setReadingPercent: (readingPercent) => set({ readingPercent }),
}));
