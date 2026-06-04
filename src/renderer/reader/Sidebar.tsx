import { useTranslation } from "react-i18next";
import { List, Highlighter, MessagesSquare } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@renderer/components/ui/tabs";
import { BookCard } from "./BookCard";
import { ChapterList } from "./ChapterList";
import { AnnotationsList } from "./AnnotationsList";
import { ConversationsTab } from "./ConversationsTab";

export function Sidebar({ bookId }: { bookId: string }) {
  const { t } = useTranslation();
  // shadcn 的 tabs 组件用 data-horizontal/data-vertical 控方向/高度，但 Base UI Tabs.Root 发的是
  // data-orientation（属性名不匹配，那些类是惰性的）——故此处显式 flex-col + TabsList h-8 兜底。
  // tab label 仅在选中态显示（i18n 宽度适配）：trigger 标 group/tab，文字 span 用 group-data-[active] 显隐；
  // 未选中只剩图标，故每个 trigger 挂 aria-label 保可读名。
  return (
    // 背景放组件内部而非经 CollapsiblePane className 传入（镜像 AIPanel）：半透明 bg-muted/30
    // 若传给 CollapsiblePane 会被 tailwind-merge 顶掉收起态抽屉的不透明 bg-background 底 → 浮层透明。
    <div className="flex h-full flex-col bg-muted/30">
      <BookCard bookId={bookId} />
      <Tabs defaultValue="toc" className="min-h-0 flex-1 flex-col gap-0">
        <div className="shrink-0 border-b border-border p-1.5">
          <TabsList className="h-8 w-full">
            <TabsTrigger value="toc" className="group/tab" aria-label={t("reader.toc", "目录")}>
              <List />
              <span className="hidden group-data-[active]/tab:inline">
                {t("reader.toc", "目录")}
              </span>
            </TabsTrigger>
            <TabsTrigger
              value="notes"
              className="group/tab"
              aria-label={t("reader.annotations", "标注")}
            >
              <Highlighter />
              <span className="hidden group-data-[active]/tab:inline">
                {t("reader.annotations", "标注")}
              </span>
            </TabsTrigger>
            <TabsTrigger
              value="conversations"
              className="group/tab"
              aria-label={t("reader.conversations", "会话")}
            >
              <MessagesSquare />
              <span className="hidden group-data-[active]/tab:inline">
                {t("reader.conversations", "会话")}
              </span>
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="toc" className="min-h-0 overflow-hidden">
          <ChapterList bookId={bookId} />
        </TabsContent>
        <TabsContent value="notes" className="min-h-0 overflow-hidden">
          <AnnotationsList bookId={bookId} />
        </TabsContent>
        <TabsContent value="conversations" className="min-h-0 overflow-hidden">
          <ConversationsTab bookId={bookId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
