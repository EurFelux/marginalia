import { z } from "zod";
import { annotationStyle } from "@shared/annotations";
import { uiLanguage } from "@shared/i18n/language";

/** 正文字体档位:default=原书默认(零干预);其余映射到打包字体栈(见 renderer 的 font-stacks)。 */
export const readerFontFamily = z.enum(["default", "wenkai", "serif", "sans"]);
export type ReaderFontFamily = z.infer<typeof readerFontFamily>;

/** 阅读排版偏好(字号倍率 / 行距 / 栏宽 px / 字体档)。@renderer/types 的 ReaderPrefs 由此推导，单一源。 */
export const readerPrefsSchema = z.object({
  fontScale: z.number(),
  lineHeight: z.number(),
  maxWidth: z.number().int(),
  // .default 保旧落盘 JSON(无此字段)parse 通过,不连带重置字号/行距/栏宽
  fontFamily: readerFontFamily.default("default"),
});
export type ReaderPrefs = z.infer<typeof readerPrefsSchema>;

/** 颜色模式三档。renderer 的 ColorMode 由此推导，单一源。 */
export const colorMode = z.enum(["light", "dark", "system"]);
export type ColorMode = z.infer<typeof colorMode>;

/** 阅读器三向布局开关（左栏 / AI 面板 / 顶栏），整对象落盘、重启恢复。 */
export const readerLayoutSchema = z.object({
  sidebarOpen: z.boolean(),
  panelOpen: z.boolean(),
  headerOpen: z.boolean(),
});
export type ReaderLayout = z.infer<typeof readerLayoutSchema>;

/** PDF 缩放倍率（相对适宽）。存倍率而非档位索引：档位表增删时旧倍率仍可收敛到最近档，索引则会错位。 */
export const pdfZoomSchema = z.number().positive();

/** 摘要模型（章节/全书摘要 + 会话自动命名）：显式 (provider, model) 对；未存 = 未配置（报错态，无回退）。 */
export const summaryModelSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
});
export type SummaryModel = z.infer<typeof summaryModelSchema>;

/** AI 对话 agent 循环的多步上限。0 = 不限制（永不主动刹车，仅靠模型自然停止 + 用户 abort）；≥1 = 具体步数上限。 */
export const stepLimitSchema = z.number().int().min(0);

/** stepLimit 缺省值：主进程兜底（makeSendDeps / runSend）与渲染层初值共用单一源。 */
export const DEFAULT_STEP_LIMIT = 10;

/** 聊天模型（接替 assistants 表配置；spec 2026-06-10 §2.2）：语义同 summaryModel——显式对，未存 = 未配置。 */
export const chatModelSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
});
export type ChatModel = z.infer<typeof chatModelSchema>;

/** agent 自我设定（SOUL）：name 独立字段（UI 显示用），persona 自由 markdown。用户与 AI 都可写。 */
export const soulSchema = z.object({
  name: z.string().min(1),
  persona: z.string(),
});
export type Soul = z.infer<typeof soulSchema>;

/** SOUL 出厂值：默认名 Lia（margina-lia 词尾）；persona 简短留白，供用户与 Lia 共同演化。 */
export const DEFAULT_SOUL: Soul = {
  name: "Lia",
  persona:
    "You are a warm, curious, and thoughtful reading companion. You genuinely care about how your reader thinks and grows. Keep your voice gentle and concise; let personality come through naturally rather than performing it.",
};

/**
 * 可持久化用户偏好的单一源：key → 值 Zod schema。
 * 新增偏好＝在此注册一个 key + schema；DB / 服务 / IPC / 类型全部据此推导。
 */
export const PREFERENCE_SCHEMAS = {
  readerPrefs: readerPrefsSchema,
  lastHighlightStyle: annotationStyle,
  autoSummarize: z.boolean(),
  onboardingDismissed: z.boolean(),
  colorMode,
  language: uiLanguage,
  readerLayout: readerLayoutSchema,
  summaryModel: summaryModelSchema,
  pdfZoom: pdfZoomSchema,
  stepLimit: stepLimitSchema,
  chatModel: chatModelSchema,
  memoryEnabled: z.boolean(),
  soul: soulSchema,
  instructions: z.string(),
} as const;

export type PreferenceKey = keyof typeof PREFERENCE_SCHEMAS;
export type PreferenceValue<K extends PreferenceKey> = z.infer<(typeof PREFERENCE_SCHEMAS)[K]>;

/** 合法 key 校验（IPC 边界用）。 */
export const preferenceKey = z.enum(
  Object.keys(PREFERENCE_SCHEMAS) as [PreferenceKey, ...PreferenceKey[]],
);

/** 全偏好快照（渲染层启动 hydrate 用）：仅含已存且校验通过的 key。 */
export type PreferencesSnapshot = Partial<{ [K in PreferenceKey]: PreferenceValue<K> }>;

/**
 * `preferences:set` IPC 入参：按 key 判别校验 value（边界处即拒非法形状）。
 * 每注册一个新 key，须在此补一条对应 arm（`preferences.test.ts` 校验与 PREFERENCE_SCHEMAS 同步）。
 */
export const setPreferenceInput = z.discriminatedUnion("key", [
  z.object({ key: z.literal("readerPrefs"), value: readerPrefsSchema }),
  z.object({ key: z.literal("lastHighlightStyle"), value: annotationStyle }),
  z.object({ key: z.literal("autoSummarize"), value: z.boolean() }),
  z.object({ key: z.literal("onboardingDismissed"), value: z.boolean() }),
  z.object({ key: z.literal("colorMode"), value: colorMode }),
  z.object({ key: z.literal("language"), value: uiLanguage }),
  z.object({ key: z.literal("readerLayout"), value: readerLayoutSchema }),
  z.object({ key: z.literal("summaryModel"), value: summaryModelSchema }),
  z.object({ key: z.literal("pdfZoom"), value: pdfZoomSchema }),
  z.object({ key: z.literal("stepLimit"), value: stepLimitSchema }),
  z.object({ key: z.literal("chatModel"), value: chatModelSchema }),
  z.object({ key: z.literal("memoryEnabled"), value: z.boolean() }),
  z.object({ key: z.literal("soul"), value: soulSchema }),
  z.object({ key: z.literal("instructions"), value: z.string() }),
]);
export type SetPreferenceInput = z.infer<typeof setPreferenceInput>;
