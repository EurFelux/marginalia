// 把跨栏 UI 状态汇到一个小 context（替代状态库）：当前章、面板折叠、选区、
// 草稿 chips/文本、对话(经 useMockChat)、本章摘要状态、阅读偏好。

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Annotation,
  ChatMessage,
  Chip,
  HighlightColor,
  PresetId,
  ReaderPrefs,
  SelectionInfo,
  SummaryStatus,
} from "#/mock/types";
import { BOOK, DEFAULT_PREFS, PRESETS, SEED_ANNOTATIONS, buildChips } from "#/mock/fixtures";
import { useMockChat } from "#/mock/useMockChat";

const SUMMARY_CYCLE: SummaryStatus[] = ["pending", "generating", "ready", "unavailable"];

let annoCounter = 0;

interface HighlightPopoverState {
  annotationId: string;
  x: number;
  y: number;
  autoFocusNote: boolean;
}

type ParagraphHighlight = {
  annId: string;
  color: HighlightColor;
  start: number;
  end: number;
  hasNote: boolean;
};

interface ReaderAIValue {
  book: typeof BOOK;
  currentChapterId: string;
  setCurrentChapterId: (id: string) => void;

  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  headerOpen: boolean;
  setHeaderOpen: (open: boolean) => void;

  // 选区（由 Reader 写入；驱动浮动工具栏）
  selection: SelectionInfo | null;
  setSelection: (s: SelectionInfo | null) => void;

  // 草稿（点 AI 动作后预填，等待发送）
  draftChips: Chip[];
  draftText: string;
  setDraftText: (t: string) => void;
  focusNonce: number; // 自增 → Composer 聚焦
  startAiAction: (preset: PresetId | null) => void;
  /** 当前草稿选区触及的章节（length>1 = 跨章 → 独立会话）。 */
  draftChapterIds: string[];

  // 对话
  messages: ChatMessage[];
  isStreaming: boolean;
  sendDraft: () => void;
  stop: () => void;
  newConversation: () => void;
  /** 已发送过的选区触及章节（驱动会话作用域：单章 / 跨章独立会话）。 */
  conversationChapterIds: string[];

  // 侧栏会话高亮（仅视觉）
  activeConversationId: string | null;
  setActiveConversationId: (id: string | null) => void;

  // 本章摘要状态（可循环演示降级态）
  summaryStatus: SummaryStatus;
  cycleSummaryStatus: (chapterId?: string) => void;
  summaryStatusOf: (chapterId: string) => SummaryStatus;

  // 标注 / 笔记
  annotations: Annotation[];
  /** 从当前选区落一条标注；返回 id（无选区返回 null）。 */
  addAnnotation: (color: HighlightColor, note?: string) => string | null;
  updateAnnotation: (id: string, patch: Partial<Pick<Annotation, "color" | "note">>) => void;
  removeAnnotation: (id: string) => void;
  /** 取某段落命中的标注片段（供正文渲染高亮）。 */
  annotationsForParagraph: (chapterId: string, paragraphIndex: number) => ParagraphHighlight[];
  highlightPopover: HighlightPopoverState | null;
  openHighlightPopover: (id: string, x: number, y: number, autoFocusNote?: boolean) => void;
  closeHighlightPopover: () => void;

  // 阅读偏好
  prefs: ReaderPrefs;
  updatePrefs: (patch: Partial<ReaderPrefs>) => void;
}

const Ctx = createContext<ReaderAIValue | null>(null);

export function ReaderAIProvider({ children }: { children: ReactNode }) {
  const [currentChapterId, setCurrentChapterId] = useState(BOOK.chapters[0].id);
  const [panelOpen, setPanelOpen] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [headerOpen, setHeaderOpen] = useState(true);
  const [selection, setSelectionState] = useState<SelectionInfo | null>(null);
  const [draftChips, setDraftChips] = useState<Chip[]>([]);
  const [draftText, setDraftText] = useState("");
  const [focusNonce, setFocusNonce] = useState(0);
  const [draftChapterIds, setDraftChapterIds] = useState<string[]>([]);
  const [conversationChapterIds, setConversationChapterIds] = useState<string[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>("conv-1");
  const [prefs, setPrefs] = useState<ReaderPrefs>(DEFAULT_PREFS);
  const [statuses, setStatuses] = useState<Record<string, SummaryStatus>>(() =>
    Object.fromEntries(BOOK.chapters.map((c) => [c.id, c.summaryStatus])),
  );
  const [annotations, setAnnotations] = useState<Annotation[]>(SEED_ANNOTATIONS);
  const [highlightPopover, setHighlightPopover] = useState<HighlightPopoverState | null>(null);

  const chat = useMockChat();
  const selectionRef = useRef<SelectionInfo | null>(null);
  const lastParagraph = useRef<string | null>(null);

  const setSelection = useCallback((s: SelectionInfo | null) => {
    selectionRef.current = s;
    setSelectionState(s);
  }, []);

  const startAiAction = useCallback(
    (preset: PresetId | null) => {
      const sel = selectionRef.current;
      if (!sel) return;
      if (sel.chapterIds[0]) setCurrentChapterId(sel.chapterIds[0]);
      setDraftChapterIds(sel.chapterIds);
      setDraftChips(buildChips(sel));
      setDraftText(preset ? (PRESETS.find((p) => p.id === preset)?.template ?? "") : "");
      setPanelOpen(true);
      setFocusNonce((n) => n + 1);
      if (typeof window !== "undefined") window.getSelection()?.removeAllRanges();
      setSelection(null); // 收起工具栏；chips 已捕获进草稿
    },
    [setSelection],
  );

  const sendDraft = useCallback(() => {
    if (draftChips.length === 0 && draftText.trim() === "") return;
    const text = draftText.trim() || "请就选中的文本展开说说。";

    // 段落去重：与上一次插入的段落相同 → 本轮省略 paragraph chip
    const para = draftChips.find((c) => c.id === "paragraph");
    const chips =
      para && para.content === lastParagraph.current
        ? draftChips.filter((c) => c.id !== "paragraph")
        : draftChips;
    if (para) lastParagraph.current = para.content;

    chat.send(text, chips);
    if (draftChapterIds.length) setConversationChapterIds(draftChapterIds);
    setDraftChips([]);
    setDraftText("");
    setDraftChapterIds([]);
    setPanelOpen(true);
  }, [chat, draftChips, draftText, draftChapterIds]);

  const newConversation = useCallback(() => {
    chat.reset();
    setDraftChips([]);
    setDraftText("");
    setDraftChapterIds([]);
    setConversationChapterIds([]);
    lastParagraph.current = null;
    setSelection(null);
    setActiveConversationId(null);
  }, [chat, setSelection]);

  const cycleSummaryStatus = useCallback(
    (chapterId?: string) => {
      const target = chapterId ?? currentChapterId;
      setStatuses((prev) => {
        const cur = prev[target] ?? "pending";
        const next = SUMMARY_CYCLE[(SUMMARY_CYCLE.indexOf(cur) + 1) % SUMMARY_CYCLE.length];
        return { ...prev, [target]: next };
      });
    },
    [currentChapterId],
  );

  const summaryStatusOf = useCallback(
    (chapterId: string): SummaryStatus => statuses[chapterId] ?? "pending",
    [statuses],
  );

  const updatePrefs = useCallback((patch: Partial<ReaderPrefs>) => {
    setPrefs((prev) => ({ ...prev, ...patch }));
  }, []);

  const addAnnotation = useCallback(
    (color: HighlightColor, note = ""): string | null => {
      const sel = selectionRef.current;
      if (!sel || sel.ranges.length === 0) return null;
      const id = `anno-${++annoCounter}`;
      const ann: Annotation = {
        id,
        color,
        note,
        text: sel.selectionText,
        chapterId: sel.ranges[0].chapterId,
        ranges: sel.ranges,
        createdAt: Date.now(),
      };
      setAnnotations((prev) => [...prev, ann]);
      if (typeof window !== "undefined") window.getSelection()?.removeAllRanges();
      setSelection(null); // 收起选区工具栏
      return id;
    },
    [setSelection],
  );

  const updateAnnotation = useCallback(
    (id: string, patch: Partial<Pick<Annotation, "color" | "note">>) => {
      setAnnotations((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    },
    [],
  );

  const removeAnnotation = useCallback((id: string) => {
    setAnnotations((prev) => prev.filter((a) => a.id !== id));
    setHighlightPopover((p) => (p?.annotationId === id ? null : p));
  }, []);

  const annotationsForParagraph = useCallback(
    (chapterId: string, paragraphIndex: number): ParagraphHighlight[] => {
      const out: ParagraphHighlight[] = [];
      for (const a of annotations)
        for (const r of a.ranges)
          if (r.chapterId === chapterId && r.paragraphIndex === paragraphIndex)
            out.push({
              annId: a.id,
              color: a.color,
              start: r.start,
              end: r.end,
              hasNote: a.note.trim() !== "",
            });
      return out;
    },
    [annotations],
  );

  const openHighlightPopover = useCallback(
    (annotationId: string, x: number, y: number, autoFocusNote = false) => {
      setHighlightPopover({ annotationId, x, y, autoFocusNote });
    },
    [],
  );
  const closeHighlightPopover = useCallback(() => setHighlightPopover(null), []);

  const value = useMemo<ReaderAIValue>(
    () => ({
      book: BOOK,
      currentChapterId,
      setCurrentChapterId,
      panelOpen,
      setPanelOpen,
      sidebarOpen,
      setSidebarOpen,
      headerOpen,
      setHeaderOpen,
      selection,
      setSelection,
      draftChips,
      draftText,
      setDraftText,
      focusNonce,
      startAiAction,
      draftChapterIds,
      messages: chat.messages,
      isStreaming: chat.isStreaming,
      sendDraft,
      stop: chat.stop,
      newConversation,
      conversationChapterIds,
      activeConversationId,
      setActiveConversationId,
      summaryStatus: statuses[currentChapterId] ?? "pending",
      cycleSummaryStatus,
      summaryStatusOf,
      annotations,
      addAnnotation,
      updateAnnotation,
      removeAnnotation,
      annotationsForParagraph,
      highlightPopover,
      openHighlightPopover,
      closeHighlightPopover,
      prefs,
      updatePrefs,
    }),
    [
      currentChapterId,
      panelOpen,
      sidebarOpen,
      headerOpen,
      selection,
      setSelection,
      draftChips,
      draftText,
      focusNonce,
      startAiAction,
      draftChapterIds,
      chat.messages,
      chat.isStreaming,
      chat.stop,
      sendDraft,
      newConversation,
      conversationChapterIds,
      activeConversationId,
      statuses,
      cycleSummaryStatus,
      summaryStatusOf,
      annotations,
      addAnnotation,
      updateAnnotation,
      removeAnnotation,
      annotationsForParagraph,
      highlightPopover,
      openHighlightPopover,
      closeHighlightPopover,
      prefs,
      updatePrefs,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useReaderAI(): ReaderAIValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useReaderAI must be used within ReaderAIProvider");
  return v;
}
