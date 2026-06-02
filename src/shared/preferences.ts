import { z } from "zod";
import { annotationStyle } from "@shared/annotations";

/** 阅读排版偏好（字号倍率 / 行距 / 栏宽 px）。@renderer/types 的 ReaderPrefs 由此推导，单一源。 */
export const readerPrefsSchema = z.object({
  fontScale: z.number(),
  lineHeight: z.number(),
  maxWidth: z.number().int(),
});
export type ReaderPrefs = z.infer<typeof readerPrefsSchema>;

/**
 * 可持久化用户偏好的单一源：key → 值 Zod schema。
 * 新增偏好＝在此注册一个 key + schema；DB / 服务 / IPC / 类型全部据此推导。
 * （颜色模式等零消费方项暂不注册，待其功能落地——见 spec 非目标。）
 */
export const PREFERENCE_SCHEMAS = {
  readerPrefs: readerPrefsSchema,
  lastHighlightStyle: annotationStyle,
  autoSummarize: z.boolean(),
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
]);
export type SetPreferenceInput = z.infer<typeof setPreferenceInput>;
