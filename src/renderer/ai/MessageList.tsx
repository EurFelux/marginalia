import type { ChatStatus } from "ai";
import { Paperclip, Sparkles } from "lucide-react";
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
  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-sm text-muted-foreground">
        <Sparkles className="size-7 text-primary/50" />
        <p className="leading-relaxed">划选正文后点「AI 问」，或直接在下方提问。</p>
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
  const chips = m.metadata?.contextChips ?? [];
  const total = chips.reduce((sum, c) => sum + c.tokenCount, 0);
  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm leading-relaxed text-primary-foreground">
        {textOf(m)}
      </div>
      {chips.length > 0 && (
        <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] tabular-nums text-muted-foreground">
          <Paperclip className="size-3" />≈{total} tok
        </span>
      )}
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
        <div className="max-w-[88%] rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm leading-relaxed">
          <span className="whitespace-pre-wrap text-foreground">{text}</span>
          {streaming && <span className="ml-0.5 inline-block animate-pulse text-primary">▍</span>}
        </div>
      )}
    </div>
  );
}

function ToolStepCard({ part }: { part: ChatUIMessage["parts"][number] }) {
  const p = part as { type: string; toolName?: string; state?: string };
  const name = p.type === "dynamic-tool" ? (p.toolName ?? "tool") : p.type.replace(/^tool-/, "");
  const done = p.state === "output-available";
  return (
    <div className="flex w-full max-w-[88%] items-center gap-2 rounded-lg border border-border bg-card/60 px-2.5 py-1.5 text-xs">
      <span>📖</span>
      <span className="font-medium text-foreground">{name}</span>
      <span className="ml-auto text-muted-foreground">{done ? "已读取" : "读取中…"}</span>
    </div>
  );
}
