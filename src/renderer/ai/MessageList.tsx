import { useState } from "react";
import type { ChatStatus } from "ai";
import { getToolName } from "ai";
import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import { BookOpen, FileText, List, ScrollText, Sparkles, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AssistantAvatar } from "@renderer/ai/AssistantAvatar";
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
  const lastId = messages.at(-1)?.id;
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
            chapters={chapters}
            showAvatar={showAvatar}
            agentName={agentName}
            groupHead={i === 0 || messages[i - 1].role !== "assistant"}
          />
        ),
      )}
      {/* submitted 空窗（已发送、首 chunk 未到）：即时占位，无缝交接到 streaming 的 ▍。 */}
      {status === "submitted" && <PendingBubble />}
    </div>
  );
}

/** 脉冲光标：streaming 无文本与 submitted 占位共用的「正在思考」指示。 */
function ThinkingCursor() {
  return <span className="inline-block animate-pulse text-primary">▍</span>;
}

/** submitted 空窗占位气泡：发送后首 chunk 到达前即时显示，与 streaming 的 ThinkingCursor 无缝交接。 */
function PendingBubble() {
  return (
    <div className="group flex flex-col items-start">
      <div className="max-w-[88%] space-y-2 rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm leading-relaxed text-foreground">
        <ThinkingCursor />
      </div>
    </div>
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

function AssistantBubble({
  m,
  streaming,
  chapters,
  showAvatar,
  agentName,
  groupHead,
}: {
  m: ChatUIMessage;
  streaming: boolean;
  chapters: ChapterRefDto[];
  showAvatar: boolean;
  agentName: string;
  groupHead: boolean;
}) {
  const segs = segments(m.parts);
  const hasText = segs.some((s) => s.kind === "text");
  if (segs.length === 0 && !streaming) return null;

  const bubble = (
    <div className="group flex flex-col items-start" data-message-id={m.id}>
      {showAvatar && groupHead && (
        <span className="mb-1 text-xs font-medium text-muted-foreground">{agentName}</span>
      )}
      <div className="max-w-full space-y-2 rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm leading-relaxed text-foreground">
        {segs.map((s, i) =>
          s.kind === "text" ? (
            // Streamdown 自带 markdown 排版（经 @source 由 Tailwind 生成其类）；不叠 prose 以免边距打架
            <LocalizedStreamdown key={i}>{s.text}</LocalizedStreamdown>
          ) : (
            <ToolStepRow key={i} part={s.part} chapters={chapters} />
          ),
        )}
        {streaming && !hasText && <ThinkingCursor />}
      </div>
      {!streaming && <MessageToolbar m={m} />}
    </div>
  );

  if (!showAvatar) {
    // 开关关闭：回到原布局（气泡自身限宽 88%）。
    return (
      <div className="max-w-[88%]" data-message-id={m.id}>
        {bubble}
      </div>
    );
  }
  // 开关开启：头像列（首条显头像、后续留白）+ 内容列（缩进对齐）。
  return (
    <div className="flex max-w-[92%] items-start gap-2" data-message-id={m.id}>
      <div className="w-7 shrink-0">{groupHead && <AssistantAvatar className="size-7" />}</div>
      <div className="min-w-0 flex-1">{bubble}</div>
    </div>
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
