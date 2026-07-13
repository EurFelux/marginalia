import { isToolUIPart, type ChatStatus } from "ai";
import type { ChatUIMessage } from "@renderer/ai/types";

export type AssistantActivity = "preparing" | "reasoning" | null;

/**
 * Display-only projection for the standalone assistant activity indicator.
 * Reasoning content is deliberately never inspected; only part type/order matters.
 */
export function assistantActivity(
  status: ChatStatus,
  parts: ChatUIMessage["parts"] | undefined,
): AssistantActivity {
  if (status === "submitted") return "preparing";
  if (status !== "streaming") return null;

  for (let index = (parts?.length ?? 0) - 1; index >= 0; index -= 1) {
    const part = parts?.[index];
    if (!part) continue;
    if (part.type === "reasoning") {
      return part.state === "streaming" ? "reasoning" : "preparing";
    }
    if (part.type === "text") {
      if (part.text.length > 0) return null;
      continue;
    }
    if (isToolUIPart(part)) {
      return part.state === "output-available" || part.state === "output-error"
        ? "preparing"
        : null;
    }
  }

  return "preparing";
}
