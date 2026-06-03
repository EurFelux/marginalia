import type { ChatStatus } from "ai";
import { Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Streamdown } from "streamdown";
import { chipLabel } from "@renderer/ai/chip-label";
import type { ChatUIMessage } from "@renderer/ai/types";

function textOf(m: ChatUIMessage): string {
  return m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

export function MessageList({
  messages,
  status,
}: {
  messages: ChatUIMessage[];
  status: ChatStatus;
}) {
  const { t } = useTranslation();
  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-sm text-muted-foreground">
        <Sparkles className="size-7 text-primary/50" />
        <p className="leading-relaxed">
          {t("ai.emptyHint", "划选正文后点「AI 问」，或直接在下方提问。")}
        </p>
      </div>
    );
  }
  const lastId = messages.at(-1)?.id;
  return (
    <div className="space-y-5">
      {messages.map((m) =>
        m.role === "user" ? (
          <UserBubble key={m.id} m={m} />
        ) : (
          <AssistantBubble key={m.id} m={m} streaming={status === "streaming" && m.id === lastId} />
        ),
      )}
    </div>
  );
}

function UserBubble({ m }: { m: ChatUIMessage }) {
  const { t } = useTranslation();
  const chips = m.metadata?.contextChips ?? [];
  return (
    <div className="flex flex-col items-end">
      <div className="max-w-[88%] rounded-2xl rounded-br-sm bg-primary px-3 py-2.5 text-primary-foreground">
        {chips.length > 0 && (
          <div className="mb-2 space-y-1.5 border-b border-primary-foreground/20 pb-2">
            {chips.map((c) => (
              <div key={c.id} className="rounded-md bg-primary-foreground/10 px-2 py-1.5">
                <div className="mb-0.5 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-primary-foreground/70">
                  <span>{chipLabel(c)}</span>
                  <span className="tabular-nums">
                    ≈{c.tokenCount} {t("ai.tokUnit", "tok")}
                  </span>
                </div>
                <p className="line-clamp-3 whitespace-pre-wrap text-[12px] leading-snug text-primary-foreground/90">
                  {c.content}
                </p>
              </div>
            ))}
          </div>
        )}
        <div className="whitespace-pre-wrap text-sm leading-relaxed">{textOf(m)}</div>
      </div>
    </div>
  );
}

function AssistantBubble({ m, streaming }: { m: ChatUIMessage; streaming: boolean }) {
  const text = textOf(m);
  const toolParts = m.parts.filter((p) => p.type.startsWith("tool-") || p.type === "dynamic-tool");
  const showBubble = text !== "" || streaming;
  return (
    <div className="flex flex-col items-start gap-2">
      {toolParts.map((p, i) => (
        <ToolStepCard key={i} part={p} />
      ))}
      {showBubble && (
        <div className="max-w-[88%] rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm leading-relaxed text-foreground">
          {/* Streamdown 自带 markdown 排版（经 @source 由 Tailwind 生成其类）；不叠 prose 以免边距打架 */}
          <Streamdown>{text}</Streamdown>
          {streaming && text === "" && (
            <span className="inline-block animate-pulse text-primary">▍</span>
          )}
        </div>
      )}
    </div>
  );
}

function ToolStepCard({ part }: { part: ChatUIMessage["parts"][number] }) {
  const { t } = useTranslation();
  const p = part as { type: string; toolName?: string; state?: string };
  const name = p.type === "dynamic-tool" ? (p.toolName ?? "tool") : p.type.replace(/^tool-/, "");
  const failed = p.state === "output-error";
  const done = p.state === "output-available" || failed;
  return (
    <div className="flex w-full max-w-[88%] items-center gap-2 rounded-lg border border-border bg-card/60 px-2.5 py-1.5 text-xs">
      <span>📖</span>
      <span className="font-medium text-foreground">{name}</span>
      <span className={failed ? "ml-auto text-destructive" : "ml-auto text-muted-foreground"}>
        {failed
          ? t("ai.toolStep.failed", "读取失败")
          : done
            ? t("ai.toolStep.done", "已读取")
            : t("ai.toolStep.loading", "读取中…")}
      </span>
    </div>
  );
}
