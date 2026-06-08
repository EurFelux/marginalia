import { useTranslation } from "react-i18next";
import { CopyButton } from "@renderer/ai/CopyButton";
import { textOf } from "@renderer/ai/message-text";
import type { ChatUIMessage } from "@renderer/ai/types";

/** 气泡下方 hover/focus 揭示的动作行。当前仅复制；后续动作直接内联加入，不预造抽象。 */
export function MessageToolbar({ m }: { m: ChatUIMessage }) {
  const { t } = useTranslation();
  return (
    <div
      role="toolbar"
      aria-label={t("ai.messageActions", "消息操作")}
      className="mt-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
    >
      <CopyButton text={textOf(m)} />
    </div>
  );
}
