import { useState, type ReactNode } from "react";
import type { ChatStatus } from "ai";
import { getToolName } from "ai";
import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import { BookOpen, FileText, List, ScrollText, Sparkles, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AssistantAvatar } from "@renderer/ai/AssistantAvatar";
import { assistantActivity, type AssistantActivity } from "@renderer/ai/assistant-activity";
import { chipLabel } from "@renderer/ai/chip-label";
import { useChatActions } from "@renderer/ai/chat-actions";
import { MessageEditor } from "@renderer/ai/MessageEditor";
import { textOf } from "@renderer/ai/message-text";
import { MessageToolbar } from "@renderer/ai/MessageToolbar";
import { segments, type ToolPart } from "@renderer/ai/segments";
import { toolStepLabel, toolStepStatus } from "@renderer/ai/tool-step-label";
import type { ChatUIMessage } from "@renderer/ai/types";
import { LocalizedStreamdown } from "@renderer/components/LocalizedStreamdown";
import { cn } from "@renderer/lib/utils";
import { qk } from "@renderer/query/keys";
import { usePrefsStore } from "@renderer/store/prefs-store";
import type { ChapterRefDto } from "@shared/library";

export function MessageList({
  messages,
  status,
  bookId,
  hasMore,
  loadingMore,
}: {
  messages: ChatUIMessage[];
  status: ChatStatus;
  bookId: string | null;
  hasMore?: boolean;
  loadingMore?: boolean;
}) {
  const { t } = useTranslation();
  // 章节列表给步骤行解析人话标题（chapterId → 章节名）；静态数据，与 ChapterList 共享缓存。
  const chaptersQuery = useQuery({
    queryKey: qk.chapters(bookId ?? ""),
    queryFn: () => window.api.content.chapters({ bookId: bookId ?? "" }),
    enabled: bookId !== null,
  });
  const chapters = chaptersQuery.data ?? [];
  const showAvatar = usePrefsStore((s) => s.showAgentAvatar);
  const agentName = usePrefsStore((s) => s.soul.name);
  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-sm text-muted-foreground">
        <Sparkles className="size-7 text-primary/50" />
        <p className="leading-relaxed">
          {bookId
            ? t("ai.emptyHint", "划选正文后点「AI 问」，或直接在下方提问。")
            : t("ai.emptyHintLibrary", "直接在下方向 {{name}} 提问吧～", { name: agentName })}
        </p>
      </div>
    );
  }
  const lastMessage = messages.at(-1);
  const lastId = lastMessage?.id;
  const activity = assistantActivity(
    status,
    lastMessage?.role === "assistant" ? lastMessage.parts : undefined,
  );
  return (
    <div className="space-y-5">
      {(hasMore || loadingMore) && (
        <div className="py-2 text-center text-xs text-muted-foreground">
          {loadingMore
            ? t("ai.loadingOlder", "加载更早消息…")
            : t("ai.scrollToLoadOlder", "上滑加载更早消息")}
        </div>
      )}
      {messages.map((m, i) =>
        m.role === "user" ? (
          <UserBubble key={m.id} m={m} />
        ) : (
          <AssistantBubble
            key={m.id}
            m={m}
            streaming={status === "streaming" && m.id === lastId}
            activity={m.id === lastId ? activity : null}
            chapters={chapters}
            showAvatar={showAvatar}
            agentName={agentName}
            groupHead={i === 0 || messages[i - 1].role !== "assistant"}
          />
        ),
      )}
      {status === "submitted" && <PendingBubble showAvatar={showAvatar} agentName={agentName} />}
    </div>
  );
}

function AssistantActivityIndicator({ activity }: { activity: Exclude<AssistantActivity, null> }) {
  const { t } = useTranslation();
  const label =
    activity === "preparing"
      ? t("ai.activity.preparing", "正在准备回答…")
      : t("ai.activity.reasoning", "正在思考…");

  return (
    <div
      className="flex items-center gap-2 text-xs text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <span className="inline-flex gap-1" aria-hidden="true">
        <span className="size-1.5 rounded-full bg-primary/80 motion-safe:animate-thinking-dot" />
        <span className="size-1.5 rounded-full bg-primary/80 motion-safe:animate-thinking-dot-delay-150" />
        <span className="size-1.5 rounded-full bg-primary/80 motion-safe:animate-thinking-dot-delay-300" />
      </span>
      <span>{label}</span>
    </div>
  );
}

function PendingBubble({ showAvatar, agentName }: { showAvatar: boolean; agentName: string }) {
  return (
    <AssistantShell showAvatar={showAvatar} agentName={agentName} groupHead>
      <div className="max-w-full space-y-2 rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm leading-relaxed text-foreground">
        <AssistantActivityIndicator activity="preparing" />
      </div>
    </AssistantShell>
  );
}

function UserBubble({ m }: { m: ChatUIMessage }) {
  const { t } = useTranslation();
  const actions = useChatActions();
  const [editing, setEditing] = useState(false);
  const chips = m.metadata?.contextChips ?? [];

  if (editing) {
    return (
      <div className="flex flex-col items-end">
        <div className="w-full max-w-[88%]">
          <MessageEditor
            initialText={textOf(m)}
            busy={actions.busy}
            onCancel={() => setEditing(false)}
            onSave={(text) => {
              setEditing(false);
              actions.editAndResend(m, text);
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="group flex flex-col items-end" data-message-id={m.id}>
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
      <MessageToolbar m={m} onEdit={() => setEditing(true)} />
    </div>
  );
}

function AssistantShell({
  children,
  showAvatar,
  agentName,
  groupHead,
  messageId,
}: {
  children: ReactNode;
  showAvatar: boolean;
  agentName: string;
  groupHead: boolean;
  messageId?: string;
}) {
  const body = (
    <div className="group flex flex-col items-start" data-message-id={messageId}>
      {showAvatar && groupHead && (
        <span className="mb-1 text-xs font-medium text-muted-foreground">{agentName}</span>
      )}
      {children}
    </div>
  );

  if (!showAvatar) {
    return (
      <div className="max-w-[88%]" data-message-id={messageId}>
        {body}
      </div>
    );
  }

  return (
    <div className="flex max-w-[92%] items-start gap-2" data-message-id={messageId}>
      <div className="w-7 shrink-0">{groupHead && <AssistantAvatar className="size-7" />}</div>
      <div className="min-w-0 flex-1">{body}</div>
    </div>
  );
}

function AssistantBubble({
  m,
  streaming,
  activity,
  chapters,
  showAvatar,
  agentName,
  groupHead,
}: {
  m: ChatUIMessage;
  streaming: boolean;
  activity: AssistantActivity;
  chapters: ChapterRefDto[];
  showAvatar: boolean;
  agentName: string;
  groupHead: boolean;
}) {
  const segs = segments(m.parts);
  if (segs.length === 0 && !streaming) return null;

  return (
    <AssistantShell
      showAvatar={showAvatar}
      agentName={agentName}
      groupHead={groupHead}
      messageId={m.id}
    >
      <div className="max-w-full space-y-2 rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm leading-relaxed text-foreground">
        {segs.map((s, i) =>
          s.kind === "text" ? (
            // Streamdown 自带 markdown 排版（经 @source 由 Tailwind 生成其类）；不叠 prose 以免边距打架
            <LocalizedStreamdown key={i}>{s.text}</LocalizedStreamdown>
          ) : (
            <ToolStepRow key={i} part={s.part} chapters={chapters} />
          ),
        )}
        {activity && <AssistantActivityIndicator activity={activity} />}
      </div>
      {!streaming && <MessageToolbar m={m} />}
    </AssistantShell>
  );
}

/** 步骤行图标：lucide 按工具映射，未知工具兜底扳手。 */
const TOOL_ICONS: Record<string, LucideIcon> = {
  getToc: List,
  getChapterSummary: ScrollText,
  readChapterText: BookOpen,
  readPage: FileText,
};

function ToolStepRow({ part, chapters }: { part: ToolPart; chapters: ChapterRefDto[] }) {
  const { t } = useTranslation();
  const status = toolStepStatus(part);
  const Icon = TOOL_ICONS[getToolName(part)] ?? Wrench;
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{toolStepLabel(part, chapters, t)}</span>
      {/* i18next-instrument-ignore */}
      <span className="shrink-0">·</span>
      <span
        className={cn(
          "shrink-0",
          status === "failed" && "text-destructive",
          status === "loading" && "animate-pulse",
        )}
      >
        {status === "failed"
          ? t("ai.toolStep.failed", "失败")
          : status === "done"
            ? t("ai.toolStep.done", "完成")
            : t("ai.toolStep.loading", "读取中…")}
      </span>
    </div>
  );
}
