import { create } from "zustand";
import type { AnnotationStyle } from "@shared/annotations";
import { DEFAULT_STEP_LIMIT, type SummaryModel } from "@shared/preferences";
import type { ReaderLayout, ReaderPrefs } from "@renderer/types";
import { persistPreference } from "@renderer/store/persist-preference";

interface PrefsState {
  /** 开章时自动生成本章摘要（默认关——控成本；landing/onboarding 时引导用户开启）。 */
  autoSummarize: boolean;
  /** 摘要模型（章节/全书摘要 + 会话自动命名）；null = 未配置（生成报错/命名跳过，无回退）。 */
  summaryModel: SummaryModel | null;
  /** 阅读排版偏好（字号/行高/版心宽）。 */
  prefs: ReaderPrefs;
  /** 上次选用的高亮样式；选「高亮标记」时直接套用（Apple Books 式记忆）。 */
  lastHighlightStyle: AnnotationStyle;
  /** 阅读器三向布局开关（左栏 / AI 面板 / 顶栏）；落盘记忆，重启恢复。 */
  layout: ReaderLayout;
  /** PDF 缩放倍率（相对适宽）；落盘记忆，重启恢复。存倍率非档位索引（见 @shared/preferences）。 */
  pdfZoom: number;
  /** AI 对话 agent 循环的多步上限；0 = 不限制。落盘记忆，重启恢复。 */
  stepLimit: number;
  /** 首启 onboarding 卡片已跳过/已完成（持久化，不再唠叨）。 */
  onboardingDismissed: boolean;
}
interface PrefsActions {
  setAutoSummarize: (v: boolean) => void;
  setSummaryModel: (v: SummaryModel) => void;
  updatePrefs: (patch: Partial<ReaderPrefs>) => void;
  setLastHighlightStyle: (style: AnnotationStyle) => void;
  updateLayout: (patch: Partial<ReaderLayout>) => void;
  setPdfZoom: (v: number) => void;
  setStepLimit: (v: number) => void;
  setOnboardingDismissed: (v: boolean) => void;
}

export const PREFS_INITIAL: PrefsState = {
  autoSummarize: false,
  summaryModel: null,
  prefs: { fontScale: 1, lineHeight: 1.9, maxWidth: 640, fontFamily: "default" },
  lastHighlightStyle: "yellow",
  layout: { sidebarOpen: true, panelOpen: false, headerOpen: true },
  pdfZoom: 1,
  stepLimit: DEFAULT_STEP_LIMIT,
  onboardingDismissed: false,
};

/**
 * 应用落盘偏好的单一家。默认值为未 hydrate 前的初值；启动时由 hydratePreferences 从主进程 DB
 * 灌入，变更经 persistPreference 落盘（收口到 preferences 表单一源）。
 */
export const usePrefsStore = create<PrefsState & PrefsActions>()((set) => ({
  ...PREFS_INITIAL,
  setAutoSummarize: (autoSummarize) => {
    persistPreference({ key: "autoSummarize", value: autoSummarize });
    set({ autoSummarize });
  },
  setSummaryModel: (summaryModel) => {
    persistPreference({ key: "summaryModel", value: summaryModel });
    set({ summaryModel });
  },
  updatePrefs: (patch) =>
    set((s) => {
      const prefs = { ...s.prefs, ...patch };
      persistPreference({ key: "readerPrefs", value: prefs });
      return { prefs };
    }),
  setLastHighlightStyle: (lastHighlightStyle) => {
    persistPreference({ key: "lastHighlightStyle", value: lastHighlightStyle });
    set({ lastHighlightStyle });
  },
  updateLayout: (patch) =>
    set((s) => {
      const layout = { ...s.layout, ...patch };
      persistPreference({ key: "readerLayout", value: layout });
      return { layout };
    }),
  setPdfZoom: (pdfZoom) => {
    persistPreference({ key: "pdfZoom", value: pdfZoom });
    set({ pdfZoom });
  },
  setStepLimit: (stepLimit) => {
    persistPreference({ key: "stepLimit", value: stepLimit });
    set({ stepLimit });
  },
  setOnboardingDismissed: (onboardingDismissed) => {
    persistPreference({ key: "onboardingDismissed", value: onboardingDismissed });
    set({ onboardingDismissed });
  },
}));
