import { useState, type ReactNode } from "react";
import {
  BookOpen,
  ChevronDown,
  Highlighter,
  List,
  MessagesSquare,
  Plus,
  Trash2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { SAMPLE_CONVERSATIONS } from "#/mock/fixtures";
import { HIGHLIGHT } from "#/highlight";
import { usePopover } from "#/components/use-popover";
import { SUMMARY_BADGE, summaryPlaceholderKey } from "#/summary";
import { useReaderAI } from "#/reader-ai-context";
import { cn } from "#/lib/utils";

type Tab = "toc" | "notes" | "conversations";

export function Sidebar() {
  const { t } = useTranslation();
  const { annotations } = useReaderAI();
  const [tab, setTab] = useState<Tab>("toc");

  return (
    <div className="flex h-full flex-col bg-muted/40 font-sans">
      {/* 书库（占位：单本高亮；点开看全书概要） */}
      <div className="shrink-0 border-b border-border p-3">
        <BookCard />
      </div>

      {/* 标签栏（图标常显，仅活动页显文字 → 适配长语种不溢出） */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border p-2">
        <TabBtn
          active={tab === "toc"}
          onClick={() => setTab("toc")}
          icon={<List className="size-3.5" />}
          label={t("sidebar.tabToc")}
        />
        <TabBtn
          active={tab === "notes"}
          onClick={() => setTab("notes")}
          icon={<Highlighter className="size-3.5" />}
          label={t("sidebar.tabNotes")}
          count={annotations.length}
        />
        <TabBtn
          active={tab === "conversations"}
          onClick={() => setTab("conversations")}
          icon={<MessagesSquare className="size-3.5" />}
          label={t("sidebar.tabConversations")}
        />
      </div>

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto p-3">
        {tab === "toc" && <TocTab />}
        {tab === "notes" && <NotesTab />}
        {tab === "conversations" && <ConversationsTab />}
      </div>
    </div>
  );
}

function BookCard() {
  const { t } = useTranslation();
  const { book } = useReaderAI();
  const { open, setOpen, ref } = usePopover();
  const badge = SUMMARY_BADGE[book.summaryStatus];
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={t("sidebar.viewBookSummary")}
        className="flex w-full items-center gap-2 rounded-lg bg-background/70 p-2 text-left ring-1 ring-primary/20 transition-colors hover:bg-background"
      >
        <div className="grid size-9 shrink-0 place-items-center rounded bg-primary/10 text-primary">
          <BookOpen className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{book.title}</div>
          <div className="truncate text-xs text-muted-foreground">{book.author}</div>
        </div>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <div className="absolute inset-x-0 top-[calc(100%+6px)] z-50 rounded-xl border border-border bg-popover p-3 text-left shadow-xl">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold">{t("sidebar.bookSummary")}</span>
            <span className={cn("shrink-0 rounded-full px-1.5 py-0.5 text-[10px]", badge.cls)}>
              {t(badge.key)}
            </span>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {book.summaryStatus === "ready"
              ? book.summary
              : t(summaryPlaceholderKey(book.summaryStatus))}
          </p>
        </div>
      )}
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  icon,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "relative flex min-w-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
        active
          ? "flex-1 bg-background text-foreground shadow-sm"
          : "shrink-0 text-muted-foreground hover:bg-muted",
      )}
    >
      <span className="shrink-0">{icon}</span>
      {active && <span className="truncate">{label}</span>}
      {count !== undefined && count > 0 && (
        <span className="shrink-0 rounded-full bg-primary/15 px-1 text-[10px] leading-none text-primary">
          {count}
        </span>
      )}
    </button>
  );
}

function TocTab() {
  const { book, currentChapterId, setCurrentChapterId } = useReaderAI();
  const goChapter = (chapterId: string) => {
    setCurrentChapterId(chapterId);
    document
      .getElementById(`chapter-${chapterId}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <nav className="space-y-0.5">
      {book.toc.map((node) => (
        <button
          key={node.id}
          type="button"
          onClick={() => goChapter(node.chapterId)}
          className={cn(
            "block w-full truncate rounded-md px-2 py-1.5 text-left text-sm transition-colors",
            node.chapterId === currentChapterId
              ? "bg-primary/10 font-medium text-primary"
              : "text-foreground/80 hover:bg-muted",
          )}
        >
          {node.label}
        </button>
      ))}
    </nav>
  );
}

function NotesTab() {
  const { t } = useTranslation();
  const { book, annotations, setCurrentChapterId, removeAnnotation } = useReaderAI();

  if (annotations.length === 0) {
    return (
      <div className="px-2 py-8 text-center text-xs leading-relaxed text-muted-foreground">
        {t("sidebar.notesEmpty")}
      </div>
    );
  }

  const order = new Map(book.chapters.map((c, i) => [c.id, i]));
  const sorted = [...annotations].sort((a, b) => {
    const ra = a.ranges[0];
    const rb = b.ranges[0];
    const ca = order.get(ra.chapterId) ?? 0;
    const cb = order.get(rb.chapterId) ?? 0;
    if (ca !== cb) return ca - cb;
    if (ra.paragraphIndex !== rb.paragraphIndex) return ra.paragraphIndex - rb.paragraphIndex;
    return ra.start - rb.start;
  });

  const goto = (chapterId: string, paragraphIndex: number) => {
    setCurrentChapterId(chapterId);
    document
      .getElementById(`p-${chapterId}-${paragraphIndex}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <div className="space-y-1.5">
      {sorted.map((a) => {
        const r = a.ranges[0];
        const chap = book.chapters.find((c) => c.id === r.chapterId);
        return (
          <div
            key={a.id}
            className="group flex gap-2 rounded-lg border border-border bg-background/60 p-2"
          >
            <span
              className={cn("w-1 shrink-0 self-stretch rounded-full", HIGHLIGHT[a.color].stripe)}
            />
            <button
              type="button"
              onClick={() => goto(r.chapterId, r.paragraphIndex)}
              className="min-w-0 flex-1 text-left"
            >
              <div className="line-clamp-2 text-xs leading-relaxed text-foreground">{a.text}</div>
              {a.note && (
                <div className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">
                  ✎ {a.note}
                </div>
              )}
              <div className="mt-1 text-[10px] text-muted-foreground/70">{chap?.title}</div>
            </button>
            <button
              type="button"
              aria-label={t("annotation.delete")}
              onClick={() => removeAnnotation(a.id)}
              className="grid size-6 shrink-0 self-start place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function ConversationsTab() {
  const { t } = useTranslation();
  const { book, activeConversationId, setActiveConversationId, newConversation } = useReaderAI();
  return (
    <div className="space-y-0.5">
      <button
        type="button"
        onClick={newConversation}
        className="mb-1 flex w-full items-center gap-2 rounded-md border border-dashed border-border px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Plus className="size-3.5" /> {t("sidebar.newIndependent")}
      </button>
      {SAMPLE_CONVERSATIONS.map((c) => {
        const chap = book.chapters.find((x) => x.id === c.chapterId);
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => setActiveConversationId(c.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
              c.id === activeConversationId ? "bg-accent" : "hover:bg-muted",
            )}
          >
            <MessagesSquare className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{c.title}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">
              {c.chapterId ? chap?.title : t("sidebar.independent")}
            </span>
          </button>
        );
      })}
    </div>
  );
}
