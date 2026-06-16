import { useEffect } from "react";
import { useChatStore } from "@renderer/store/chat-store";
import type { ChatContext } from "@renderer/ai/chat-context";
import { createLogger } from "@renderer/logger";

const log = createLogger("chat");

type RestoreTarget = { kind: "restore"; id: string } | { kind: "empty" };

/**
 * 据会话列表（updatedAt 倒序）+ 记忆值，决定开「该上下文」时该恢复的目标（纯函数，便于测试）。
 * 优先级：命中记忆 > null 空态 > 回落最新 > 无会话空态。
 * - remembered=string 且仍在 list → 精确恢复上次正看的；
 * - remembered=null → 上次停在「将开新会话」空态，忠实还原（empty）；
 * - remembered 失效 / 缺键 → 回落 list[0]（最新）；list 空 → empty。
 */
export function pickRestoreTarget(
  list: readonly { id: string }[],
  remembered: string | null | undefined,
): RestoreTarget {
  const has = (id: string) => list.some((c) => c.id === id);
  if (typeof remembered === "string" && has(remembered)) return { kind: "restore", id: remembered };
  if (remembered === null) return { kind: "empty" };
  const latest = list[0];
  return latest ? { kind: "restore", id: latest.id } : { kind: "empty" };
}

type RestoreSlots = {
  activeByBook: Record<string, string | null>;
  activeLibraryConversation: string | null;
};
type RestoreAction =
  | { kind: "restore"; id: string }
  | { kind: "empty"; presetSummaryChips: boolean };

/**
 * 据上下文挑记忆槽（book→activeByBook[bookId]，library→activeLibraryConversation），
 * 再经 pickRestoreTarget 决策（纯函数，便于测试）。
 * 空态仅 book 预亮摘要 chips——library 无书/章，摘要 pill 不渲染，预亮无意义。
 * library 的 activeLibraryConversation 初值即 null（非 undefined）⇒ 首次使用走 empty（开新会话），不回落最新。
 */
export function resolveRestore(
  ctx: ChatContext,
  slots: RestoreSlots,
  list: readonly { id: string }[],
): RestoreAction {
  const remembered =
    ctx.kind === "book" ? slots.activeByBook[ctx.bookId] : slots.activeLibraryConversation;
  const target = pickRestoreTarget(list, remembered);
  if (target.kind === "restore") return target;
  return { kind: "empty", presetSummaryChips: ctx.kind === "book" };
}

/**
 * 恢复某上下文上次的会话（spec §7，泛化到 book + library）：取该上下文会话列表
 * （book→bookId，library→null），按 resolveRestore 决定恢复哪个 / 还原空态。
 * 命中/回落 → restoreConversation（发 context-tagged openCommand 载历史，不强开面板）；
 * 空态 → 置 active null（写槽 null + 清 openCommand），book 再预亮摘要 chips。
 *
 * 入参 ctx=null ⇒ 不跑（如阅读器尚无书）。effect 仅依赖从 ctx 派生的稳定基元
 * kind/bookId，不依赖每 render 新建的 ctx 对象（正确性不押在 React Compiler 记忆化上）。
 */
export function useRestoreConversation(ctx: ChatContext | null) {
  const kind = ctx?.kind ?? null;
  const bookId = ctx?.kind === "book" ? ctx.bookId : null;
  useEffect(() => {
    if (!kind) return;
    const restoreCtx: ChatContext =
      bookId !== null ? { kind: "book", bookId } : { kind: "library" };
    let cancelled = false;
    void window.api.chat.conversations
      .listByBook({ bookId })
      .then((list) => {
        if (cancelled) return;
        const s = useChatStore.getState();
        const action = resolveRestore(restoreCtx, s, list);
        if (action.kind === "restore") {
          s.restoreConversation(restoreCtx, action.id);
        } else {
          s.setActiveConversation(restoreCtx, null);
          if (action.presetSummaryChips) s.setSummaryChipsPreset();
        }
      })
      .catch((err: unknown) => log.warn("restore conversation failed", err));
    return () => {
      cancelled = true;
    };
  }, [kind, bookId]);
}
