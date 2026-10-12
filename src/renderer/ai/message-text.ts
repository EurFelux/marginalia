import { answerText, assistantLayout } from "@renderer/ai/process-fold";
import { segments } from "@renderer/ai/segments";
import type { ChatUIMessage } from "@renderer/ai/types";

/** 拼接消息所有 text part（跳过 tool/step 等非文本 part）——即消息的 markdown 源。 */
export function textOf(m: ChatUIMessage): string {
  return m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/**
 * 消息常显区的文本（spec 2026-10-12 assistant-process-fold §3.1、§3.7）——与界面上照常显示的回答一致，
 * 复制按钮复制它。没有工具调用的消息即全部文本；回复以过程类工具调用结尾时为空串。
 */
export function answerTextOf(m: ChatUIMessage): string {
  return answerText(assistantLayout(segments(m.parts), () => false).answer);
}
