import { useEffect } from "react";
import { useChatStore } from "@renderer/store/chat-store";
import { createLogger } from "@renderer/logger";

const log = createLogger("chat");

type RestoreTarget = { kind: "restore"; id: string } | { kind: "empty" };

/**
 * 据该书会话列表（updatedAt 倒序）+ 记忆值，决定开书该恢复的目标（纯函数，便于测试）。
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

/**
 * 开书恢复会话（spec §7）：取该书会话列表，按 pickRestoreTarget 决定恢复哪个 /
 * 还原空态。命中/回落 → restoreConversation（发 openCommand 载历史）；
 * 空态 → 置 active null（写槽 null + 清 openCommand）+ 预亮摘要 chips。
 */
export function useRestoreConversation(bookId: string | null) {
  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
    void window.api.chat.conversations
      .listByBook({ bookId })
      .then((list) => {
        if (cancelled) return;
        const s = useChatStore.getState();
        const target = pickRestoreTarget(list, s.activeByBook[bookId]);
        if (target.kind === "restore") {
          s.restoreConversation(target.id);
        } else {
          s.setActiveConversation(null);
          s.setSummaryChipsPreset();
        }
      })
      .catch((err: unknown) => log.warn("restore conversation failed", err));
    return () => {
      cancelled = true;
    };
  }, [bookId]);
}
