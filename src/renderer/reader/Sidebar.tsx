import { useTranslation } from "react-i18next";
import { List, Highlighter } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@renderer/components/ui/tabs";
import { BookCard } from "./BookCard";
import { ChapterList } from "./ChapterList";
import { AnnotationsList } from "./AnnotationsList";

export function Sidebar({ bookId }: { bookId: string }) {
  const { t } = useTranslation();
  // shadcn 的 tabs 组件用 data-horizontal/data-vertical 控方向/高度，但 Base UI Tabs.Root 发的是
  // data-orientation（属性名不匹配，那些类是惰性的）——故此处显式 flex-col + TabsList h-8 兜底。
  return (
    <div className="flex h-full flex-col">
      <BookCard bookId={bookId} />
      <Tabs defaultValue="toc" className="min-h-0 flex-1 flex-col gap-0">
        <div className="shrink-0 border-b border-border p-1.5">
          <TabsList className="h-8 w-full">
            <TabsTrigger value="toc">
              <List />
              {t("reader.toc", "目录")}
            </TabsTrigger>
            <TabsTrigger value="notes">
              <Highlighter />
              {t("reader.annotations", "标注")}
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="toc" className="min-h-0 overflow-hidden">
          <ChapterList bookId={bookId} />
        </TabsContent>
        <TabsContent value="notes" className="min-h-0 overflow-hidden">
          <AnnotationsList bookId={bookId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
