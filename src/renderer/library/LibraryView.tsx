import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookOpen, FolderOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BookSummaryDto, UpdateBookInput } from "@shared/library";
import { Button } from "@renderer/components/ui/button";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { qk } from "@renderer/query/keys";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { fileNameOf, pickBookFiles } from "./book-drop";
import { useEpubDrop } from "./use-epub-drop";
import { DropOverlay } from "./DropOverlay";
import { BookCover } from "./BookCover";
import { RecentlyReadShelf } from "./RecentlyReadShelf";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy } from "@dnd-kit/sortable";
import { SortableBook } from "./SortableBook";
import { OnboardingCard } from "./OnboardingCard";

interface ImportItem {
  filePath: string;
  name: string;
}

export function LibraryView() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const openBook = useNavigationStore((s) => s.openBook);
  const books = useQuery({
    queryKey: qk.library,
    queryFn: () => window.api.library.list(),
  });

  // 按钮导入与拖拽导入收敛到同一批量 mutation：顺序逐本导入，收集成功的书与失败项。
  const importBooks = useMutation({
    mutationFn: async (items: ImportItem[]) => {
      const ok: BookSummaryDto[] = [];
      const failed: { name: string; error: string }[] = [];
      for (const it of items) {
        try {
          ok.push(await window.api.library.import({ filePath: it.filePath }));
        } catch (e) {
          failed.push({ name: it.name, error: (e as Error).message });
        }
      }
      return { ok, failed };
    },
    onSuccess: (r) => {
      if (r.ok.length > 0) void qc.invalidateQueries({ queryKey: qk.library });
    },
  });

  // 删书：调既有 library:delete IPC（主进程级联删 DB + unlink 导入书籍副本），成功后失效刷新书库 + toast。
  const deleteBook = useMutation({
    mutationFn: (b: BookSummaryDto) => window.api.library.delete({ bookId: b.id }),
    onSuccess: (_r, b) => {
      void qc.invalidateQueries({ queryKey: qk.library });
      // shelf 键不含 bookId（["recently-read"]），下面的谓词移除轮不到它；删的书可能正在
      // shelf 上（DB 侧 progress 已级联删），不失效就一直挂着死书（staleTime:0 只救重挂载）。
      void qc.invalidateQueries({ queryKey: qk.recentlyRead });
      // 该书的 per-book 缓存（book/chapters/toc/bytes/progress/annotations/summary/conversations…）
      // 整体移除（remove 非 invalidate——书已不在，不该 refetch）。否则重导同一文件（id=文件哈希
      // 不变）后开书会命中删除前的陈旧缓存（staleTime=∞），如旧 title=null 致侧栏书卡显示 id 哈希。
      qc.removeQueries({ predicate: (q) => q.queryKey.includes(b.id) });
      toast.success(t("library.deleted", "已删除《{{title}}》", { title: b.title ?? b.id }));
    },
    onError: (e, b) => {
      // 透传主进程真实错误（honest-error），不自动消失。
      toast.error(
        t("library.deleteFailed", "{{title}} 删除失败：{{error}}", {
          title: b.title ?? b.id,
          error: (e as Error).message,
        }),
        { closeButton: true, duration: Infinity },
      );
    },
  });

  // 编辑书名/作者：成功静默（卡片即时刷新就是反馈）；失败 toast 透传主进程真实错误（honest-error）。
  // qk.book(bookId) 必须一并失效——reader 侧栏 BookCard 与顶栏面包屑共用该 key，且 staleTime=∞。
  const updateBook = useMutation({
    mutationFn: (input: UpdateBookInput) => window.api.library.update(input),
    onSuccess: (_r, input) => {
      void qc.invalidateQueries({ queryKey: qk.library });
      void qc.invalidateQueries({ queryKey: qk.book(input.bookId) });
    },
    onError: (e, input) => {
      toast.error(
        t("library.updateFailed", "{{title}} 保存失败：{{error}}", {
          title: input.title,
          error: (e as Error).message,
        }),
        { closeButton: true, duration: Infinity },
      );
    },
  });

  // 切换「已读完」（#70）：成功静默（角标即时刷新即反馈）；失败 toast 透传真实错误。
  // qk.book(bookId) 一并失效——reader 侧栏 BookCard 共用且 staleTime=∞；shelf 也显示角标故失效 recentlyRead。
  const setFinished = useMutation({
    mutationFn: (v: { bookId: string; finished: boolean }) => window.api.library.setFinished(v),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: qk.library });
      void qc.invalidateQueries({ queryKey: qk.book(v.bookId) });
      void qc.invalidateQueries({ queryKey: qk.recentlyRead });
    },
    onError: (e, v) => {
      const b = books.data?.find((x) => x.id === v.bookId);
      toast.error(
        t("library.setFinishedFailed", "{{title}} 标记失败：{{error}}", {
          title: b?.title ?? v.bookId,
          error: (e as Error).message,
        }),
        { closeButton: true, duration: Infinity },
      );
    },
  });

  // 拖拽排序（#48 spec §6.2）：8px 位移激活（与点击打开互斥）；乐观更新缓存后全量 reorder，
  // 失败 invalidate 恢复真序 + toast 透传真实错误（honest-error）。
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const reorder = useMutation({
    mutationFn: (orderedIds: string[]) => window.api.library.reorder({ orderedIds }),
    onError: (e) => {
      void qc.invalidateQueries({ queryKey: qk.library });
      toast.error(
        t("library.reorderFailed", "排序保存失败：{{error}}", {
          error: (e as Error).message,
        }),
        { closeButton: true, duration: Infinity },
      );
    },
  });

  const onDragStart = (e: DragStartEvent) => setDraggingId(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setDraggingId(null);
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const list = books.data;
    if (!list) return;
    const from = list.findIndex((b) => b.id === active.id);
    const to = list.findIndex((b) => b.id === over.id);
    if (from < 0 || to < 0) return;
    const next = arrayMove(list, from, to);
    qc.setQueryData(qk.library, next); // 乐观：先动 UI
    reorder.mutate(next.map((b) => b.id));
  };

  const draggingBook = draggingId ? books.data?.find((b) => b.id === draggingId) : undefined;

  // 即时 toast 反馈：新增 / 已在库（幂等复用）/ 忽略非 epub / 失败（透传主进程真实错误，不自动消失）。
  const runImport = async (items: ImportItem[], ignored: string[]) => {
    if (items.length === 0 && ignored.length === 0) return;
    const existing = new Set(books.data?.map((b) => b.id) ?? []);
    const r = items.length > 0 ? await importBooks.mutateAsync(items) : { ok: [], failed: [] };
    const added = r.ok.filter((b) => !existing.has(b.id)).length;
    const duplicate = r.ok.length - added;

    if (added > 0) toast.success(t("library.imported", "已导入 {{count}} 本", { count: added }));
    if (duplicate > 0) {
      toast.info(t("library.duplicate", "{{count}} 本已在书库", { count: duplicate }));
    }
    if (ignored.length > 0) {
      // 列表分隔符按当前 UI 语言本地化（中文顿号 / 英文逗号），勿硬编码。
      const names = new Intl.ListFormat(i18n.language, {
        style: "narrow",
        type: "unit",
      }).format(ignored);
      toast.warning(
        t("library.ignored", "已忽略 {{count}} 个不支持的文件：{{names}}", {
          count: ignored.length,
          names,
        }),
      );
    }
    for (const f of r.failed) {
      toast.error(
        t("library.importFailed", "{{name}} 导入失败：{{error}}", {
          name: f.name,
          error: f.error,
        }),
        { closeButton: true, duration: Infinity },
      );
    }
  };

  // 拖拽落点：过滤受支持书籍格式 → 取路径 → 批量导入；忽略项进 toast。
  const onFiles = (files: File[]) => {
    const { books, ignored } = pickBookFiles(files);
    const items = books.map((f) => ({
      filePath: window.api.library.pathForFile(f),
      name: f.name,
    }));
    void runImport(
      items,
      ignored.map((f) => f.name),
    );
  };

  // 按钮导入：原生对话框取单个路径 → 同一批量通道。
  const onPick = async () => {
    const filePath = await window.api.library.pickBook();
    if (!filePath) return;
    void runImport([{ filePath, name: fileNameOf(filePath) }], []);
  };

  const { isDragging, isOverZone, rootHandlers, zoneHandlers } = useEpubDrop(onFiles);

  return (
    <div {...rootHandlers} className="flex h-full flex-col overflow-hidden">
      <div className="flex h-12 shrink-0 items-center justify-between px-6">
        <span className="text-sm text-muted-foreground">
          {t("library.count", "共 {{count}} 本", { count: books.data?.length ?? 0 })}
        </span>
        <Button onClick={() => void onPick()} disabled={importBooks.isPending}>
          <FolderOpen />
          {importBooks.isPending
            ? t("library.importPending", "导入中…")
            : t("library.import", "导入书籍")}
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <main className="p-6">
          <OnboardingCard />
          <RecentlyReadShelf onOpen={openBook} />
          {books.isPending && (
            <p className="text-sm text-muted-foreground">{t("library.loading", "加载书库…")}</p>
          )}
          {books.isError && (
            <p className="text-sm text-destructive">{t("library.loadError", "读取书库失败")}</p>
          )}
          {books.data?.length === 0 && (
            <div className="mt-20 text-center text-muted-foreground">
              <BookOpen className="mx-auto mb-3 size-10 opacity-40" />
              <p className="text-sm">
                {t("library.empty", "书库为空，点上方「导入书籍」或把 .epub / .pdf 拖进窗口开始。")}
              </p>
            </div>
          )}
          <DndContext
            sensors={sensors}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            onDragCancel={() => setDraggingId(null)}
          >
            <SortableContext
              items={books.data?.map((b) => b.id) ?? []}
              strategy={rectSortingStrategy}
            >
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-5">
                {books.data?.map((b) => (
                  <SortableBook
                    key={b.id}
                    book={b}
                    onOpen={() => openBook(b.id)}
                    onDelete={() => deleteBook.mutate(b)}
                    onUpdate={(patch) => updateBook.mutate({ bookId: b.id, ...patch })}
                    onToggleFinished={() =>
                      setFinished.mutate({ bookId: b.id, finished: !b.isFinished })
                    }
                  />
                ))}
              </ul>
            </SortableContext>
            <DragOverlay>
              {draggingBook ? (
                <BookCover
                  book={draggingBook}
                  onOpen={() => {}}
                  onDelete={() => {}}
                  onUpdate={() => {}}
                  onToggleFinished={() => {}}
                />
              ) : null}
            </DragOverlay>
          </DndContext>
        </main>
      </ScrollArea>

      {isDragging && <DropOverlay active={isOverZone} zoneHandlers={zoneHandlers} />}
    </div>
  );
}
