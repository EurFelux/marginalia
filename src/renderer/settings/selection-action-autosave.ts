// 划词指令编辑区的自动保存决策（纯函数，spec 2026-10-12-custom-selection-actions-design §3.6）。
import {
  SELECTION_ACTION_LABEL_MAX,
  SELECTION_ACTION_PROMPT_MAX,
  normalizeBuiltinPrompt,
  type CreateSelectionActionInput,
  type SelectionActionDto,
  type SelectionActionIcon,
  type UpdateSelectionActionInput,
} from "@shared/selection-actions";

/** 编辑区里的字段；文字 / 提示语是输入框原文（未去首尾空白）。内置指令只用 prompt 与 autoSend。 */
export interface EditorFields {
  label: string;
  icon: SelectionActionIcon;
  prompt: string;
  autoSend: boolean;
}

export type FieldError = "labelEmpty" | "labelTooLong" | "promptEmpty" | "promptTooLong";

/** 字段校验：自建指令文字与提示语必填；内置指令的提示语可空（= 用默认）。 */
export function validateFields(kind: SelectionActionDto["kind"], f: EditorFields): FieldError[] {
  const errors: FieldError[] = [];
  const prompt = f.prompt.trim();
  if (kind === "custom") {
    const label = f.label.trim();
    if (label === "") errors.push("labelEmpty");
    else if (label.length > SELECTION_ACTION_LABEL_MAX) errors.push("labelTooLong");
    if (prompt === "") errors.push("promptEmpty");
  }
  if (prompt.length > SELECTION_ACTION_PROMPT_MAX) errors.push("promptTooLong");
  return errors;
}

/** 编辑的对象：还没写入表的草稿（creating = 新建请求在路上），或已保存的指令（取其最新 DTO）。 */
export type AutosaveTarget =
  | { kind: "draft"; creating: boolean }
  | { kind: "saved"; dto: SelectionActionDto };

export type AutosaveRequest =
  | { kind: "create"; input: CreateSelectionActionInput }
  | { kind: "update"; input: UpdateSelectionActionInput };

/**
 * 当前字段要发什么请求；null = 不发。
 * - 草稿：全部合规才新建；新建请求还在路上时不发（回来后对已保存的值再比一次）。
 * - 已保存：只发和已保存值不同、且本身合规的字段；不合规的字段留在输入框里、不写入。
 * - 内置指令的提示语留空或与默认相同 → 存 null（用默认）。
 */
export function planAutosave(
  target: AutosaveTarget,
  fields: EditorFields,
  defaultPrompt: string,
): AutosaveRequest | null {
  const errors = new Set(
    validateFields(target.kind === "draft" ? "custom" : target.dto.kind, fields),
  );
  const label = fields.label.trim();
  const prompt = fields.prompt.trim();

  if (target.kind === "draft") {
    if (target.creating || errors.size > 0) return null;
    return {
      kind: "create",
      input: { label, icon: fields.icon, prompt, autoSend: fields.autoSend },
    };
  }

  const saved = target.dto;
  if (saved.kind === "builtin") {
    const patch: Extract<UpdateSelectionActionInput, { kind: "builtin" }>["patch"] = {};
    const nextPrompt = normalizeBuiltinPrompt(fields.prompt, defaultPrompt);
    if (!errors.has("promptTooLong") && nextPrompt !== saved.prompt) patch.prompt = nextPrompt;
    if (fields.autoSend !== saved.autoSend) patch.autoSend = fields.autoSend;
    if (Object.keys(patch).length === 0) return null;
    return { kind: "update", input: { kind: "builtin", id: saved.id, patch } };
  }

  const patch: Extract<UpdateSelectionActionInput, { kind: "custom" }>["patch"] = {};
  if (!errors.has("labelEmpty") && !errors.has("labelTooLong") && label !== saved.label) {
    patch.label = label;
  }
  if (fields.icon !== saved.icon) patch.icon = fields.icon;
  if (!errors.has("promptEmpty") && !errors.has("promptTooLong") && prompt !== saved.prompt) {
    patch.prompt = prompt;
  }
  if (fields.autoSend !== saved.autoSend) patch.autoSend = fields.autoSend;
  if (Object.keys(patch).length === 0) return null;
  return { kind: "update", input: { kind: "custom", id: saved.id, patch } };
}
