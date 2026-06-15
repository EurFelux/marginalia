import { create } from "zustand";
import type { AnnotationStyle } from "@shared/annotations";
import {
  DEFAULT_BACKGROUND_CONCURRENCY,
  DEFAULT_SOUL,
  DEFAULT_STEP_LIMIT,
  DEFAULT_TTS_PREFS,
  type ChatModel,
  type Soul,
  type SummaryModel,
  type TtsPrefs,
} from "@shared/preferences";
import { DEFAULT_WEB_SEARCH, type WebSearchConfig } from "@shared/web-search";
import type { ReaderLayout, ReaderPrefs } from "@renderer/types";
import { persistPreference } from "@renderer/store/persist-preference";

interface PrefsState {
  /** 开章时自动生成本章摘要（默认关——控成本；landing/onboarding 时引导用户开启）。 */
  autoSummarize: boolean;
  /** 对话模型（接替 assistants 表配置）；null = 未配置（发送报错，无回退）。 */
  chatModel: ChatModel | null;
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
  /** 后台模型调用全局并发上限（章节/全书摘要 + 命名 + 压缩）；前台对话不受限。落盘记忆。 */
  backgroundConcurrency: number;
  /** 首启 onboarding 卡片已跳过/已完成（持久化，不再唠叨）。 */
  onboardingDismissed: boolean;
  /** AI 记忆功能总开关（默认开）。 */
  memoryEnabled: boolean;
  /** agent 自我设定（SOUL）：name + persona。 */
  soul: Soul;
  /** 用户自定义全局指令（叠加在 SOUL persona 之上）。 */
  instructions: string;
  /** 朗读（TTS）偏好：语速 + 语种→voice 名映射。 */
  ttsPrefs: TtsPrefs;
  /** 对话中显示头像总开关（默认开）。 */
  showAgentAvatar: boolean;
  /** 当前头像 blob 引用；null = 用默认头像。由主进程 agent IPC 落盘，渲染层只镜像。 */
  avatarBlobId: string | null;
  /** 联网搜索配置（enabled + backends）；null = 未 hydrate 前的占位（hydrate 后至少为出厂默认）。 */
  webSearch: WebSearchConfig | null;
}
interface PrefsActions {
  setAutoSummarize: (v: boolean) => void;
  setChatModel: (v: ChatModel) => void;
  setSummaryModel: (v: SummaryModel) => void;
  updatePrefs: (patch: Partial<ReaderPrefs>) => void;
  setLastHighlightStyle: (style: AnnotationStyle) => void;
  updateLayout: (patch: Partial<ReaderLayout>) => void;
  setPdfZoom: (v: number) => void;
  setStepLimit: (v: number) => void;
  setBackgroundConcurrency: (v: number) => void;
  setOnboardingDismissed: (v: boolean) => void;
  setMemoryEnabled: (v: boolean) => void;
  setSoul: (v: Soul) => void;
  setInstructions: (v: string) => void;
  updateTtsPrefs: (patch: Partial<TtsPrefs>) => void;
  setShowAgentAvatar: (v: boolean) => void;
  setAvatarBlobId: (v: string | null) => void;
  setWebSearch: (v: WebSearchConfig) => void;
}

export const PREFS_INITIAL: PrefsState = {
  autoSummarize: false,
  chatModel: null,
  summaryModel: null,
  prefs: { fontScale: 1, lineHeight: 1.9, maxWidth: 640, fontFamily: "default" },
  lastHighlightStyle: "yellow",
  layout: { sidebarOpen: true, panelOpen: false, headerOpen: true },
  pdfZoom: 1,
  stepLimit: DEFAULT_STEP_LIMIT,
  backgroundConcurrency: DEFAULT_BACKGROUND_CONCURRENCY,
  onboardingDismissed: false,
  memoryEnabled: true,
  soul: DEFAULT_SOUL,
  instructions: "",
  ttsPrefs: DEFAULT_TTS_PREFS,
  showAgentAvatar: true,
  avatarBlobId: null,
  webSearch: DEFAULT_WEB_SEARCH,
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
  setChatModel: (chatModel) => {
    persistPreference({ key: "chatModel", value: chatModel });
    set({ chatModel });
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
  setBackgroundConcurrency: (backgroundConcurrency) => {
    persistPreference({ key: "backgroundConcurrency", value: backgroundConcurrency });
    set({ backgroundConcurrency });
  },
  setOnboardingDismissed: (onboardingDismissed) => {
    persistPreference({ key: "onboardingDismissed", value: onboardingDismissed });
    set({ onboardingDismissed });
  },
  setMemoryEnabled: (memoryEnabled) => {
    persistPreference({ key: "memoryEnabled", value: memoryEnabled });
    set({ memoryEnabled });
  },
  setSoul: (soul) => {
    persistPreference({ key: "soul", value: soul });
    set({ soul });
  },
  setInstructions: (instructions) => {
    persistPreference({ key: "instructions", value: instructions });
    set({ instructions });
  },
  updateTtsPrefs: (patch) =>
    set((s) => {
      const ttsPrefs = { ...s.ttsPrefs, ...patch };
      persistPreference({ key: "ttsPrefs", value: ttsPrefs });
      return { ttsPrefs };
    }),
  setShowAgentAvatar: (showAgentAvatar) => {
    persistPreference({ key: "showAgentAvatar", value: showAgentAvatar });
    set({ showAgentAvatar });
  },
  setAvatarBlobId: (avatarBlobId) => set({ avatarBlobId }),
  setWebSearch: (webSearch) => {
    persistPreference({ key: "webSearch", value: webSearch });
    set({ webSearch });
  },
}));
