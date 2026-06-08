// src/main/ai/context-compaction.ts
import type { MessageDto } from "@shared/chat";
import { renderHistoryMessage } from "@main/ai/prompt";

/** 尾轮估算超此值（token）才触发压缩。 */
export const TAIL_TOKENS_HIGH = 100_000;
/** 压缩目标：折叠到尾轮估算 ≤ 此值。 */
export const TAIL_TOKENS_LOW = 10_000;
/** 最少逐字保留的消息条数（地板，优先于低水位）。 */
export const MIN_RECENT_TURNS = 20;
/** 滚动概要单次再摘要的输出上限（token）。 */
export const SUMMARY_MAX_TOKENS = 4096;
/** 折叠转写喂模型的字符上限；超出前载截断（保留较新的折叠内容）。 */
export const COMPACTION_INPUT_MAX_CHARS = 180_000;

export interface FoldPlan {
  /** S 推进到的消息 seq（最后一条被折叠的 assistant 消息）。 */
  foldThroughSeq: number;
  /** 被折叠进概要的轮（升序）。 */
  foldedTurns: MessageDto[];
}

export interface FoldBudget {
  high: number;
  low: number;
  minRecent: number;
}

/**
 * 纯函数：给定尾轮（seq 升序、user/assistant 交替起于 user）与每条估算 token 的函数，
 * 决定折叠哪个前缀。仅当尾轮估算 > high 才折；尽量多保留近期轮（折到 ≤ low），但至少
 * 保留 minRecent 条，且折叠边界落在 assistant 上（折完整对话对）。无可折返回 null。
 */
export function planFold(
  tail: MessageDto[],
  tokensOf: (m: MessageDto) => number,
  budget: FoldBudget,
): FoldPlan | null {
  const total = tail.reduce((s, m) => s + tokensOf(m), 0);
  if (total <= budget.high) return null;

  // 从最新往旧累积保留：keep 至少 minRecent 条；超过后，一旦再加更老一条会越过 low 就停。
  let keep = 0;
  let acc = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const t = tokensOf(tail[i]!);
    if (keep >= budget.minRecent && acc + t > budget.low) break;
    acc += t;
    keep++;
  }

  // 对齐：保留区须以 user 起（折叠区以 assistant 收）；若首条是 assistant，多保留它前面的 user。
  let keepStart = tail.length - keep;
  if (keepStart > 0 && tail[keepStart]!.role === "assistant") keepStart--;

  const foldCount = keepStart;
  if (foldCount <= 0) return null;
  return { foldThroughSeq: tail[foldCount - 1]!.seq, foldedTurns: tail.slice(0, foldCount) };
}

/** 把折叠轮转写成「User: …\nAssistant: …」串；超长前载截断保留较新内容。 */
export function renderFoldedTranscript(
  folded: MessageDto[],
  maxChars = COMPACTION_INPUT_MAX_CHARS,
): string {
  const transcript = folded
    .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${renderHistoryMessage(m)}`)
    .join("\n\n");
  return transcript.length > maxChars ? transcript.slice(transcript.length - maxChars) : transcript;
}
