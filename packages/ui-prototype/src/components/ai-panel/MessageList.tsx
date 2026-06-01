import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Check, ChevronRight, Loader2, Paperclip, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ChatMessage, Chip, ToolStep } from "#/mock/types";
import { cn } from "#/lib/utils";

export function MessageList({ messages }: { messages: ChatMessage[] }) {
  const { t } = useTranslation();
  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-sm text-muted-foreground">
        <Sparkles className="size-7 text-primary/50" />
        <p className="leading-relaxed">{t("messages.empty")}</p>
      </div>
    );
  }
  return (
    <div className="space-y-5">
      {messages.map((m) =>
        m.role === "user" ? <UserBubble key={m.id} m={m} /> : <AssistantBubble key={m.id} m={m} />,
      )}
    </div>
  );
}

function UserBubble({ m }: { m: Extract<ChatMessage, { role: "user" }> }) {
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm leading-relaxed text-primary-foreground">
        {m.text}
      </div>
      {m.chips.length > 0 && <ContextSummary chips={m.chips} />}
    </div>
  );
}

/** 紧凑上下文摘要：只显示总 token；hover 弹 popover 列各 chip 明细。 */
function ContextSummary({ chips }: { chips: Chip[] }) {
  const { t } = useTranslation();
  const [rect, setRect] = useState<DOMRect | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const total = chips.reduce((sum, c) => sum + c.tokenCount, 0);

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setRect(null), 160);
  };

  return (
    <>
      <button
        type="button"
        onMouseEnter={(e) => {
          cancelClose();
          setRect(e.currentTarget.getBoundingClientRect());
        }}
        onMouseLeave={scheduleClose}
        className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground transition-colors hover:bg-accent"
      >
        <Paperclip className="size-3" />≈{total} tok
      </button>
      {rect &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
            style={{
              position: "fixed",
              left: Math.min(Math.max(rect.right - 208, 12), window.innerWidth - 220),
              bottom: window.innerHeight - rect.top + 8,
              zIndex: 60,
            }}
            className="w-52 rounded-lg border border-border bg-popover p-2 shadow-xl"
          >
            <div className="mb-1 px-1 text-[11px] font-medium text-foreground">
              {t("messages.contextTitle")}
            </div>
            <div className="space-y-0.5">
              {chips.map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between gap-2 rounded px-1 py-0.5 text-[11px]"
                >
                  <span className="truncate text-foreground">{t(c.labelKey)}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    ≈{c.tokenCount} tok
                  </span>
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

function AssistantBubble({ m }: { m: Extract<ChatMessage, { role: "assistant" }> }) {
  const { t } = useTranslation();
  const error = m.status === "error";
  const showBubble = m.text !== "" || m.status === "streaming";
  return (
    <div className="flex flex-col items-start gap-2">
      {m.steps.map((s) => (
        <ToolStepCard key={s.id} step={s} />
      ))}
      {showBubble && (
        <div
          className={cn(
            "max-w-[88%] rounded-2xl rounded-bl-sm px-3.5 py-2 text-sm leading-relaxed",
            error ? "bg-destructive/10 ring-1 ring-destructive/30" : "bg-muted",
          )}
        >
          <span className="whitespace-pre-wrap text-foreground">{m.text}</span>
          {m.status === "streaming" && (
            <span className="ml-0.5 inline-block animate-pulse text-primary">▍</span>
          )}
          {error && (
            <div className="mt-1.5 flex items-center gap-1 text-xs text-destructive">
              <AlertTriangle className="size-3.5" /> {t("messages.incomplete")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolStepCard({ step }: { step: ToolStep }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const running = step.status === "running";
  return (
    <div className="w-full max-w-[88%] overflow-hidden rounded-lg border border-border bg-card/60 text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted/50"
      >
        <span>📖</span>
        <span className="font-medium text-foreground">{step.label}</span>
        {running ? (
          <Loader2 className="size-3 animate-spin text-muted-foreground" />
        ) : (
          <Check className="size-3 text-emerald-500" />
        )}
        <span className="ml-auto text-muted-foreground">
          {running ? t("messages.reading") : t("messages.read")}
        </span>
        <ChevronRight
          className={cn("size-3 text-muted-foreground transition-transform", open && "rotate-90")}
        />
      </button>
      {open && (
        <div className="border-t border-border bg-background/50 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground">
          {step.detail}
        </div>
      )}
    </div>
  );
}
