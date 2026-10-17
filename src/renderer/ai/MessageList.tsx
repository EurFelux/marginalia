import { Fragment, useState, type ReactNode } from "react";
import type { ChatStatus } from "ai";
import { getToolName } from "ai";
import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import {
  AppWindow,
  BookOpen,
  Brain,
  ChevronRight,
  FileText,
  Globe,
  List,
  ScrollText,
  Search,
  Sparkles,
  SquareTerminal,
  UserPen,
  WandSparkles,
  Wrench,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { AssistantAvatar } from "@renderer/ai/AssistantAvatar";
import { BashBlock } from "@renderer/ai/BashBlock";
import { assistantActivity, type AssistantActivity } from "@renderer/ai/assistant-activity";
import { chipLabel } from "@renderer/ai/chip-label";
import { useChatActions } from "@renderer/ai/chat-actions";
import { MessageEditor } from "@renderer/ai/MessageEditor";
import { textOf } from "@renderer/ai/message-text";
import { dayKind, messageCreatedAt, startsNewDay } from "@renderer/ai/message-time";
import { MessageTimestamp } from "@renderer/ai/MessageTimestamp";
import { MessageToolbar } from "@renderer/ai/MessageToolbar";
import {
  assistantLayout,
  hasToolCall,
  runningStep,
  turnDurationParts,
} from "@renderer/ai/process-fold";
import { segments, type Segment, type ToolPart } from "@renderer/ai/segments";
import { toolStepLabel, toolStepStatus } from "@renderer/ai/tool-step-label";
import type { ChatUIMessage } from "@renderer/ai/types";
import { LocalizedStreamdown } from "@renderer/components/LocalizedStreamdown";
import { cn } from "@renderer/lib/utils";
import { qk } from "@renderer/query/keys";
import { usePermissionStore } from "@renderer/store/permission-store";
import { usePrefsStore } from "@renderer/store/prefs-store";
import type { ChapterRefDto } from "@shared/library";

/**
 * 流式正文逐字淡入（Streamdown 内置 animate 插件，仅 isAnimating 时注入 span，已显示的字不重播）。
 * sep 用 char：默认 word 按空白切分，中文无空格会整段一起淡入。
 * stagger 必须为 0：每批字到达即渲染（useChat 50ms 合批，快模型一批一二十字），批内错开会拖过下一批到达，
 * 前批末尾比后批开头更透明，形成多道此起彼伏的波。为 0 时透明度沿文本单调递增，只有一道拖尾；
 * duration 决定拖尾长短（约最近 duration 毫秒内到达的字仍在淡入）。
 */
const STREAM_ANIMATION = { animation: "fadeIn", sep: "char", duration: 500, stagger: 0 } as const;

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
            ? t("ai.emptyHint", "划选正文后点「询问」，或直接在下方提问。")
            : t("ai.emptyHintLibrary", "直接在下方向 {{name}} 提问吧～", { name: agentName })}
        </p>
      </div>
    );
  }
  const lastMessage = messages.at(-1);
  const lastId = lastMessage?.id;
  // live 消息（本轮发送/流式产出）尚未回读落库时间，统一以本次渲染时刻兜底。
  const nowMs = Temporal.Now.instant().epochMilliseconds;
  const timeZone = Temporal.Now.timeZoneId();
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
      {messages.map((m, i) => {
        const createdAt = messageCreatedAt(m, nowMs);
        const prevAt = i === 0 ? null : messageCreatedAt(messages[i - 1], nowMs);
        return (
          <Fragment key={m.id}>
            {startsNewDay(prevAt, createdAt, timeZone) && (
              <DayDivider at={createdAt} nowMs={nowMs} timeZone={timeZone} />
            )}
            {m.role === "user" ? (
              <UserBubble m={m} createdAt={createdAt} timeZone={timeZone} />
            ) : (
              <AssistantBubble
                m={m}
                createdAt={createdAt}
                timeZone={timeZone}
                streaming={status === "streaming" && m.id === lastId}
                activity={m.id === lastId ? activity : null}
                chapters={chapters}
                showAvatar={showAvatar}
                groupHead={i === 0 || messages[i - 1].role !== "assistant"}
              />
            )}
          </Fragment>
        );
      })}
      {status === "submitted" && <PendingBubble showAvatar={showAvatar} />}
    </div>
  );
}

/** 跨自然日时插入的日期分隔行：今天/昨天用人话，更早给绝对日期。 */
function DayDivider({ at, nowMs, timeZone }: { at: number; nowMs: number; timeZone: string }) {
  const { t, i18n } = useTranslation();
  const kind = dayKind(at, nowMs, timeZone);
  const label =
    kind === "today"
      ? t("ai.day.today", "今天")
      : kind === "yesterday"
        ? t("ai.day.yesterday", "昨天")
        : new Intl.DateTimeFormat(i18n.language, { dateStyle: "long", timeZone }).format(at);
  return (
    <div className="flex items-center gap-3" role="separator" aria-label={label}>
      <span className="h-px flex-1 bg-border" aria-hidden />
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span className="h-px flex-1 bg-border" aria-hidden />
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

function PendingBubble({ showAvatar }: { showAvatar: boolean }) {
  return (
    <AssistantShell showAvatar={showAvatar} groupHead>
      <div className="max-w-full space-y-2 rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm leading-relaxed text-foreground">
        <AssistantActivityIndicator activity="preparing" />
      </div>
    </AssistantShell>
  );
}

function UserBubble({
  m,
  createdAt,
  timeZone,
}: {
  m: ChatUIMessage;
  createdAt: number;
  timeZone: string;
}) {
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
    <div className="group relative flex flex-col items-end" data-message-id={m.id}>
      <MessageTimestamp at={createdAt} timeZone={timeZone} align="end" />
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
  timestamp,
  showAvatar,
  groupHead,
  messageId,
}: {
  children: ReactNode;
  /** 气泡上方的 hover 浮层（原先此处常驻 agent 名字）。 */
  timestamp?: ReactNode;
  showAvatar: boolean;
  groupHead: boolean;
  messageId?: string;
}) {
  const body = (
    <div className="group relative flex flex-col items-start" data-message-id={messageId}>
      {timestamp}
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
  createdAt,
  timeZone,
  streaming,
  activity,
  chapters,
  showAvatar,
  groupHead,
}: {
  m: ChatUIMessage;
  createdAt: number;
  timeZone: string;
  streaming: boolean;
  activity: AssistantActivity;
  chapters: ChapterRefDto[];
  showAvatar: boolean;
  groupHead: boolean;
}) {
  const segs = segments(m.parts);
  const pendingRequests = usePermissionStore((s) => s.pending);
  if (segs.length === 0 && !streaming) return null;

  // 最后一次过程类工具调用及其之前的内容收进折叠区；待批 bash 留在外面（spec 2026-10-12 §3.1、§3.5）。
  const layout = assistantLayout(
    segs,
    (p) => getToolName(p) === "bash" && pendingRequests[p.toolCallId] !== undefined,
  );

  return (
    <AssistantShell
      showAvatar={showAvatar}
      groupHead={groupHead}
      messageId={m.id}
      timestamp={
        // 流式途中不亮时间：那一刻的「现在」还在走，等落库时刻定下来再显示。
        streaming ? undefined : (
          <MessageTimestamp at={createdAt} timeZone={timeZone} align="start" />
        )
      }
    >
      <div className="max-w-full space-y-2 rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm leading-relaxed text-foreground">
        {hasToolCall(layout.process) ? (
          <ProcessFold
            process={layout.process}
            durationMs={m.metadata?.durationMs}
            chapters={chapters}
            streaming={streaming}
          />
        ) : (
          // 没有工具调用可收（待批块前只剩几句话）：不出折叠区，文本照常显示
          layout.process.map(
            (s, i) =>
              s.kind === "text" && <LocalizedStreamdown key={i}>{s.text}</LocalizedStreamdown>,
          )
        )}
        {layout.awaiting.map((p) => (
          <BashBlock key={p.toolCallId} part={p} streaming={streaming} />
        ))}
        {layout.answer.map((s, i) =>
          s.kind === "text" ? (
            // Streamdown 自带 markdown 排版（经 @source 由 Tailwind 生成其类）；不叠 prose 以免边距打架
            <LocalizedStreamdown key={i} animated={STREAM_ANIMATION} isAnimating={streaming}>
              {s.text}
            </LocalizedStreamdown>
          ) : (
            // 常显区里只会有记忆类步骤（§3.1），照常显示为灰色步骤行
            <ToolStepRow key={i} part={s.part} chapters={chapters} streaming={streaming} />
          ),
        )}
        {activity && <AssistantActivityIndicator activity={activity} />}
      </div>
      {!streaming && <MessageToolbar m={m} />}
    </AssistantShell>
  );
}

/** 过程里的一段：中间文本（灰色）、bash 终端块或灰色步骤行。 */
function SegmentView({
  segment,
  chapters,
  streaming,
}: {
  segment: Segment;
  chapters: ChapterRefDto[];
  streaming: boolean;
}) {
  if (segment.kind === "text") {
    // 后面已跟着工具调用，这段话不会再增长：不带逐字淡入
    return (
      <div className="text-muted-foreground">
        <LocalizedStreamdown>{segment.text}</LocalizedStreamdown>
      </div>
    );
  }
  return getToolName(segment.part) === "bash" ? (
    // bash 不走灰色单行步骤：渲染为终端块（含审批操作栏，spec 2026-10-03 §6.4）
    <BashBlock part={segment.part} streaming={streaming} />
  ) : (
    <ToolStepRow part={segment.part} chapters={chapters} streaming={streaming} />
  );
}

/**
 * 回答之前的过程，默认收起成一行（spec 2026-10-12-assistant-process-fold §3.2–§3.4）：
 * 有工具在执行时显示这一步，否则显示本轮用时；还没有用时（生成中 / 旧消息）显示「查看过程」。
 */
function ProcessFold({
  process,
  durationMs,
  chapters,
  streaming,
}: {
  process: Segment[];
  durationMs: number | undefined;
  chapters: ChapterRefDto[];
  streaming: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  // 展开后进行中的那一步已列在下面，标题行不再重复
  const running = expanded ? null : runningStep(process, streaming);
  let label: string;
  if (durationMs === undefined) {
    label = expanded ? t("ai.process.hide", "收起过程") : t("ai.process.show", "查看过程");
  } else {
    const { min, sec } = turnDurationParts(durationMs);
    label =
      min === 0
        ? t("ai.process.durationSec", "用时 {{sec}} 秒", { sec })
        : t("ai.process.durationMin", "用时 {{min}} 分 {{sec}} 秒", { min, sec });
  }

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex max-w-full items-center gap-1.5 rounded text-start text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      >
        {running ? (
          <ToolStepRow part={running} chapters={chapters} streaming={streaming} />
        ) : (
          <span className="shrink-0">{label}</span>
        )}
        <ChevronRight
          className={cn("size-3.5 shrink-0 transition-transform", expanded && "rotate-90")}
          aria-hidden
        />
      </button>
      {expanded && (
        <div className="ms-1.5 mt-2 space-y-2 border-s-2 border-foreground/10 ps-3">
          {process.map((s, i) => (
            <SegmentView key={i} segment={s} chapters={chapters} streaming={streaming} />
          ))}
        </div>
      )}
    </div>
  );
}

/** 步骤行图标：lucide 按工具映射，未知工具兜底扳手。 */
const TOOL_ICONS: Record<string, LucideIcon> = {
  bash: SquareTerminal,
  web_search: Globe,
  web_fetch: AppWindow,
  readMemory: Brain,
  saveMemory: Brain,
  updateMemory: Brain,
  deleteMemory: Brain,
  updateSoul: UserPen,
  getToc: List,
  getChapterSummary: ScrollText,
  readChapterText: BookOpen,
  readPage: FileText,
  searchBook: Search,
  loadSkill: WandSparkles,
};

function ToolStepRow({
  part,
  chapters,
  streaming,
}: {
  part: ToolPart;
  chapters: ChapterRefDto[];
  streaming: boolean;
}) {
  const { t } = useTranslation();
  const status = toolStepStatus(part, streaming);
  const Icon = TOOL_ICONS[getToolName(part)] ?? Wrench;
  // span 而非 div：折叠区标题行把它放进 <button>（只能含短语内容）
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
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
            : status === "not-executed"
              ? t("ai.toolStep.notExecuted", "未执行")
              : getToolName(part) === "bash"
                ? t("ai.toolStep.running", "运行中")
                : t("ai.toolStep.loading", "读取中…")}
      </span>
    </span>
  );
}
