import type { ChatStatus } from "ai";
import { getToolName } from "ai";
import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import { BookOpen, FileText, List, ScrollText, Sparkles, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { chipLabel } from "@renderer/ai/chip-label";
import { textOf } from "@renderer/ai/message-text";
import { segments, type ToolPart } from "@renderer/ai/segments";
import { toolStepLabel, toolStepStatus } from "@renderer/ai/tool-step-label";
import type { ChatUIMessage } from "@renderer/ai/types";
import { LocalizedStreamdown } from "@renderer/components/LocalizedStreamdown";
import { cn } from "@renderer/lib/utils";
import { qk } from "@renderer/query/keys";
import type { ChapterRefDto } from "@shared/library";

export function MessageList({
  messages,
  status,
  bookId,
}: {
  messages: ChatUIMessage[];
  status: ChatStatus;
  bookId: string | null;
}) {
  const { t } = useTranslation();
  // 章节列表给步骤行解析人话标题（chapterId → 章节名）；静态数据，与 ChapterList 共享缓存。
  const chaptersQuery = useQuery({
    queryKey: qk.chapters(bookId ?? ""),
    queryFn: () => window.api.content.chapters({ bookId: bookId ?? "" }),
    enabled: bookId !== null,
  });
  const chapters = chaptersQuery.data ?? [];
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
          <AssistantBubble
            key={m.id}
            m={m}
            streaming={status === "streaming" && m.id === lastId}
            chapters={chapters}
          />
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

function AssistantBubble({
  m,
  streaming,
  chapters,
}: {
  m: ChatUIMessage;
  streaming: boolean;
  chapters: ChapterRefDto[];
}) {
  const segs = segments(m.parts);
  const hasText = segs.some((s) => s.kind === "text");
  if (segs.length === 0 && !streaming) return null;
  return (
    <div className="flex flex-col items-start">
      <div className="max-w-[88%] space-y-2 rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm leading-relaxed text-foreground">
        {segs.map((s, i) =>
          s.kind === "text" ? (
            // Streamdown 自带 markdown 排版（经 @source 由 Tailwind 生成其类）；不叠 prose 以免边距打架
            <LocalizedStreamdown key={i}>{s.text}</LocalizedStreamdown>
          ) : (
            <ToolStepRow key={i} part={s.part} chapters={chapters} />
          ),
        )}
        {streaming && !hasText && (
          <span className="inline-block animate-pulse text-primary">▍</span>
        )}
      </div>
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
