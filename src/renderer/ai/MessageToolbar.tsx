import { Pencil, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@renderer/components/ui/button";
import { CopyButton } from "@renderer/ai/CopyButton";
import { useChatActions } from "@renderer/ai/chat-actions";
import { textOf } from "@renderer/ai/message-text";
import type { ChatUIMessage } from "@renderer/ai/types";

/** 气泡下方 hover/focus 揭示的动作行。Copy(#67) + 按 role 的 Edit/Resend/Regenerate。 */
export function MessageToolbar({ m, onEdit }: { m: ChatUIMessage; onEdit?: () => void }) {
  const { t } = useTranslation();
  const actions = useChatActions();
  return (
    <div role="toolbar" aria-label={t("ai.messageActions", "消息操作")} className="flex gap-0.5">
      <CopyButton text={textOf(m)} />
      {m.role === "user" && (
        <>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("ai.edit", "编辑")}
            onClick={onEdit}
            disabled={actions.busy}
            className="text-muted-foreground hover:text-foreground"
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("ai.resend", "重新发送")}
            onClick={() => actions.resend(m)}
            disabled={actions.busy}
            className="text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </>
      )}
      {m.role === "assistant" && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("ai.regenerate", "重新生成")}
          onClick={() => actions.regenerate(m)}
          disabled={actions.busy}
          className="text-muted-foreground hover:text-foreground"
        >
          <RefreshCw className="size-3.5" />
        </Button>
      )}
    </div>
  );
}
