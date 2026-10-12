// 划词指令的跨层契约（spec 2026-10-12-custom-selection-actions-design）：规则常量、图标清单、IPC 入参 / 返回值。
import { z } from "zod";

/** 最多多少个指令（含内置）；只在新建时检查，上限下调不影响已存的指令。 */
export const SELECTION_ACTION_MAX = 20;
/** 自建指令文字最长多少字符。 */
export const SELECTION_ACTION_LABEL_MAX = 16;
/** 提示语最长多少字符。 */
export const SELECTION_ACTION_PROMPT_MAX = 2000;
/** 工具栏显示文字时平铺几个（出厂四个内置指令正好全部平铺），其余收进「更多」。 */
export const SELECTION_ACTION_INLINE_LABELED = 4;
/** 工具栏只显示图标时平铺几个。 */
export const SELECTION_ACTION_INLINE_ICONS = 8;

/** 内置指令 id；数组顺序即出厂顺序。 */
export const BUILTIN_SELECTION_ACTION_IDS = ["ask", "explain", "translate", "summarize"] as const;
export const builtinSelectionActionId = z.enum(BUILTIN_SELECTION_ACTION_IDS);
export type BuiltinSelectionActionId = z.infer<typeof builtinSelectionActionId>;

/**
 * 精选图标（lucide 的 kebab-case 名，spec §3.3），按用途分组，供设置页图标网格。
 * 渲染层用 `Record<SelectionActionIcon, LucideIcon>` 映射，漏配即编译报错。
 */
export const SELECTION_ACTION_ICON_GROUPS = [
  {
    id: "reading",
    icons: [
      "book-open",
      "book-a",
      "languages",
      "spell-check",
      "quote",
      "message-square-quote",
      "pilcrow",
      "scroll-text",
      "file-text",
      "library",
    ],
  },
  {
    id: "thinking",
    icons: [
      "sparkles",
      "lightbulb",
      "brain",
      "circle-help",
      "message-circle-question",
      "search",
      "glasses",
      "microscope",
      "telescope",
      "target",
    ],
  },
  {
    id: "structure",
    icons: [
      "list",
      "list-checks",
      "list-tree",
      "network",
      "route",
      "git-compare",
      "scale",
      "swords",
      "shrink",
      "expand",
    ],
  },
  {
    id: "topics",
    icons: [
      "graduation-cap",
      "baby",
      "history",
      "calendar",
      "globe",
      "map",
      "compass",
      "landmark",
      "users",
      "drama",
      "palette",
      "music",
      "sigma",
      "flask-conical",
      "code",
    ],
  },
  { id: "other", icons: ["pen-line", "wand-sparkles", "heart"] },
] as const;

export type SelectionActionIconGroupId = (typeof SELECTION_ACTION_ICON_GROUPS)[number]["id"];
export type SelectionActionIcon = (typeof SELECTION_ACTION_ICON_GROUPS)[number]["icons"][number];

export const SELECTION_ACTION_ICONS: readonly SelectionActionIcon[] =
  SELECTION_ACTION_ICON_GROUPS.flatMap((g) => g.icons);

/** 写入时图标必须在清单里；读取时不限（认不出的名字由渲染层退回 FALLBACK_SELECTION_ACTION_ICON）。 */
export const selectionActionIcon = z.enum(
  SELECTION_ACTION_ICONS as [SelectionActionIcon, ...SelectionActionIcon[]],
);

export const FALLBACK_SELECTION_ACTION_ICON: SelectionActionIcon = "sparkles";

/** 内置指令的固定图标（沿用改版前工具栏的图标）。 */
export const BUILTIN_SELECTION_ACTION_ICONS: Record<BuiltinSelectionActionId, SelectionActionIcon> =
  {
    ask: "sparkles",
    explain: "book-open",
    translate: "languages",
    summarize: "file-text",
  };

/**
 * 读出的一条指令。内置指令不带文字和图标（文字走 i18n、图标固定），
 * prompt 为 null = 用默认（解释 / 翻译 / 概括跟随界面语言，询问没有提示语）。
 */
export type SelectionActionDto =
  | {
      kind: "builtin";
      id: BuiltinSelectionActionId;
      prompt: string | null;
      enabled: boolean;
      autoSend: boolean;
    }
  | {
      kind: "custom";
      id: string;
      label: string;
      /** 读取不校验是否在清单内，故为 string。 */
      icon: string;
      prompt: string;
      enabled: boolean;
      autoSend: boolean;
    };

/** 没有存过行的内置指令：显示、不直接发送、提示语用默认。 */
export function defaultBuiltinSelectionAction(id: BuiltinSelectionActionId): SelectionActionDto {
  return { kind: "builtin", id, prompt: null, enabled: true, autoSend: false };
}

/** 出厂列表（全新安装时读出的样子）。 */
export const FACTORY_SELECTION_ACTIONS: readonly SelectionActionDto[] =
  BUILTIN_SELECTION_ACTION_IDS.map(defaultBuiltinSelectionAction);

const label = z.string().trim().min(1).max(SELECTION_ACTION_LABEL_MAX);
const prompt = z.string().trim().min(1).max(SELECTION_ACTION_PROMPT_MAX);

export const createSelectionActionInput = z.object({
  label,
  icon: selectionActionIcon,
  prompt,
  autoSend: z.boolean(),
});
export type CreateSelectionActionInput = z.infer<typeof createSelectionActionInput>;

/** 按 kind 判别：内置指令只能改提示语（null = 用默认）、显示、直接发送；自建指令还能改文字和图标。 */
export const updateSelectionActionInput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("builtin"),
    id: builtinSelectionActionId,
    patch: z
      .object({ prompt: prompt.nullable(), enabled: z.boolean(), autoSend: z.boolean() })
      .partial()
      .strict(),
  }),
  z.object({
    kind: z.literal("custom"),
    id: z.string().min(1),
    patch: z
      .object({
        label,
        icon: selectionActionIcon,
        prompt,
        enabled: z.boolean(),
        autoSend: z.boolean(),
      })
      .partial()
      .strict(),
  }),
]);
export type UpdateSelectionActionInput = z.infer<typeof updateSelectionActionInput>;

export const selectionActionIdInput = z.object({ id: z.string().min(1) });

/** 完整的新顺序；必须正好是当前列表的一个排列（主进程校验）。 */
export const reorderSelectionActionsInput = z.object({
  ids: z.array(z.string().min(1)).max(1000),
});

const ICON_SET = new Set<string>(SELECTION_ACTION_ICONS);

/** 读出的图标名 → 清单内的图标；认不出的名字（将来从清单删掉的）退回 FALLBACK_SELECTION_ACTION_ICON。 */
export function toSelectionActionIcon(name: string): SelectionActionIcon {
  return ICON_SET.has(name) ? (name as SelectionActionIcon) : FALLBACK_SELECTION_ACTION_ICON;
}

/** 内置指令的出厂文字与默认提示语（依赖 i18n，由渲染层注入；「询问」的默认提示语为空串）。 */
export interface BuiltinSelectionDefaults {
  label: (id: BuiltinSelectionActionId) => string;
  prompt: (id: BuiltinSelectionActionId) => string;
}

/** 工具栏 / 点击时用的一条指令：文字、图标、实际提示语都已解析。 */
export interface SelectionActionView {
  id: string;
  kind: SelectionActionDto["kind"];
  label: string;
  icon: SelectionActionIcon;
  /** 实际提示语：读者写的，没写就用默认；为空串 = 没有提示语（只可能是没写提示语的「询问」）。 */
  prompt: string;
  /** 实际是否直接发送：开关开着且有提示语。 */
  autoSend: boolean;
  enabled: boolean;
}

export function resolveSelectionAction(
  dto: SelectionActionDto,
  defaults: BuiltinSelectionDefaults,
): SelectionActionView {
  const builtin = dto.kind === "builtin";
  const prompt = builtin ? (dto.prompt ?? defaults.prompt(dto.id)) : dto.prompt;
  return {
    id: dto.id,
    kind: dto.kind,
    label: builtin ? defaults.label(dto.id) : dto.label,
    icon: builtin ? BUILTIN_SELECTION_ACTION_ICONS[dto.id] : toSelectionActionIcon(dto.icon),
    prompt,
    autoSend: dto.autoSend && prompt.trim() !== "",
    enabled: dto.enabled,
  };
}

/** 内置指令提示语的存法：留空或与当前语言的默认值相同 → null（用默认，跟随语言），否则存去掉首尾空白的文字。 */
export function normalizeBuiltinPrompt(input: string, defaultPrompt: string): string | null {
  const trimmed = input.trim();
  return trimmed === "" || trimmed === defaultPrompt.trim() ? null : trimmed;
}
