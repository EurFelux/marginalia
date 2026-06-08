import type { ChatUIMessage } from "@renderer/ai/types";

/** 拼接消息所有 text part（跳过 tool/step 等非文本 part）——即消息的 markdown 源。 */
export function textOf(m: ChatUIMessage): string {
  return m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}
