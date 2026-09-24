import { create } from "zustand";
import type { BookSearchHit, BookSearchResult } from "@shared/search";

/** 阅读器侧栏标签页（受控：⌘F 需要切到搜索页）。value 字符串沿用既有 tab 值。 */
export type SidebarTab = "toc" | "search" | "notes" | "conversations" | "book-notes";

interface SearchState {
  /** 当前结果所属的书；换书时重置。 */
  bookId: string | null;
  /** 输入框里的原始文本。 */
  query: string;
  /** 最近一次搜索的结果及其查询串（高亮以 resultQuery 为准，而非尚在防抖中的 query）。 */
  result: BookSearchResult | null;
  resultQuery: string;
  activeIndex: number | null;
  sidebarTab: SidebarTab;
  /** 命令信号：递增即请求聚焦搜索输入框。 */
  focusNonce: number;
  /** 命令信号：nonce 递增触发阅读器跳到该命中。 */
  jump: { hit: BookSearchHit; query: string; nonce: number } | null;
}

interface SearchActions {
  openSearch: () => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setQuery: (query: string) => void;
  setResult: (bookId: string, query: string, result: BookSearchResult | null) => void;
  activate: (index: number) => void;
  /** 下一个（+1）/ 上一个（-1），首尾循环；尚无当前命中时 +1 从第一个、-1 从最后一个开始。 */
  step: (delta: 1 | -1) => void;
  resetForBook: (bookId: string | null) => void;
}

export const SEARCH_INITIAL: SearchState = {
  bookId: null,
  query: "",
  result: null,
  resultQuery: "",
  activeIndex: null,
  sidebarTab: "toc",
  focusNonce: 0,
  jump: null,
};

export const useSearchStore = create<SearchState & SearchActions>((set, get) => ({
  ...SEARCH_INITIAL,
  openSearch: () => set((s) => ({ sidebarTab: "search", focusNonce: s.focusNonce + 1 })),
  setSidebarTab: (sidebarTab) => set({ sidebarTab }),
  setQuery: (query) => set({ query }),
  setResult: (bookId, resultQuery, result) =>
    set({ bookId, resultQuery, result, activeIndex: null }),
  activate: (index) => {
    const { result, resultQuery, jump } = get();
    const hit = result?.kind === "ok" ? result.hits[index] : undefined;
    if (!hit) return;
    set({
      activeIndex: index,
      jump: { hit, query: resultQuery, nonce: (jump?.nonce ?? 0) + 1 },
    });
  },
  step: (delta) => {
    const { result, activeIndex, activate } = get();
    const count = result?.kind === "ok" ? result.hits.length : 0;
    if (count === 0) return;
    const next =
      activeIndex === null ? (delta === 1 ? 0 : count - 1) : (activeIndex + delta + count) % count;
    activate(next);
  },
  resetForBook: (bookId) =>
    set({ bookId, query: "", result: null, resultQuery: "", activeIndex: null, jump: null }),
}));
