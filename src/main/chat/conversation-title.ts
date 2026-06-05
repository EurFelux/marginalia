// src/main/chat/conversation-title.ts
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { conversations } from "@main/db/schema";
import type { ResolvedModel } from "@main/ai/assistant-model";

const MAX_TITLE_LEN = 40;

// 用 \u 转义写死，防格式化器再次吞字符：
//   U+0022 " ASCII 直双引号   U+0027 ' ASCII 直单引号
//   U+201C " 左弯双引号       U+201D " 右弯双引号
//   U+2018 ' 左弯单引号       U+2019 ' 右弯单引号
//   U+300C 「 左单书名号       U+300D 」 右单书名号
//   U+300E 『 左双书名号       U+300F 』 右双书名号
const QUOTE_EDGES = /^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g;

const NAMING_SYSTEM =
  "你是会话命名助手。根据给出的一轮对话，产出一个能概括话题的简短标题。" +
  "要求：使用与对话内容相同的语言；不超过 15 个字/词；只输出标题本身，不要引号、句号或任何解释。";

export interface NamingDeps {
  db: DB;
  resolveModel: () => ResolvedModel;
}

// 命名中状态：进程内存瞬态（spec §5）——settle 即清除、不落库；重启自然归零，
// 失败遗留的 null title 不会被误标为命名中。
const namingInFlight = new Set<string>();

export function isNamingConversation(id: string): boolean {
  return namingInFlight.has(id);
}

/** 仅供测试：清空命名运行时态。 */
export function __resetNamingRuntime(): void {
  namingInFlight.clear();
}

/** 清洗模型产出：取首个非空行、剥首尾引号、压缩空白、截断到 MAX_TITLE_LEN（超出加省略号）。 */
export function sanitizeTitle(raw: string): string {
  const firstLine =
    raw
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const unquoted = firstLine.replace(QUOTE_EDGES, "");
  const collapsed = unquoted.replace(/\s+/g, " ").trim();
  return [...collapsed].length <= MAX_TITLE_LEN // oxlint-disable-line no-misused-spread
    ? collapsed
    : [...collapsed].slice(0, MAX_TITLE_LEN).join("") + "…"; // oxlint-disable-line no-misused-spread
}

/**
 * 首轮完成后的会话自动命名（spec §5）：用触发轮的 user+assistant 做一次非流式短调用。
 * fire-and-forget：失败/未配置模型 → title 保持 null（UI 走 i18n 占位）、仅落日志——绝不编造标题。
 */
export async function nameConversation(
  deps: NamingDeps,
  conversationId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  if (namingInFlight.has(conversationId)) return;
  const resolved = deps.resolveModel();
  if (!resolved.ok) {
    console.warn("[naming] model not configured; keep title null:", resolved.reason);
    return;
  }
  namingInFlight.add(conversationId);
  try {
    const { text } = await generateText({
      model: resolved.model,
      system: NAMING_SYSTEM,
      prompt: `用户：${userText}\n\n助手：${assistantText}`,
    });
    const title = sanitizeTitle(text);
    if (!title) return;
    // 写回前复查 title 仍为 null——不覆盖期间已被设置的标题
    const row = deps.db
      .select({ title: conversations.title })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get();
    if (row && row.title == null) {
      deps.db
        .update(conversations)
        .set({ title })
        .where(eq(conversations.id, conversationId))
        .run();
    }
  } catch (err) {
    console.warn("[naming] failed; keep title null:", err);
  } finally {
    namingInFlight.delete(conversationId);
  }
}
