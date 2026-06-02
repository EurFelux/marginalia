import { List, Highlighter } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@renderer/components/ui/tabs";
import { ChapterList } from "./ChapterList";
import { AnnotationsList } from "./AnnotationsList";

export function Sidebar({ bookId }: { bookId: string }) {
  return (
    <Tabs defaultValue="toc" className="h-full gap-0">
      <div className="shrink-0 border-b border-border p-1.5">
        <TabsList className="w-full">
          <TabsTrigger value="toc">
            <List />
            目录
          </TabsTrigger>
          <TabsTrigger value="notes">
            <Highlighter />
            标注
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
  );
}
