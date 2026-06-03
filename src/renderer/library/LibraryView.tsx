import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookOpen, FolderOpen, Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BookSummaryDto } from "@shared/library";
import { Button } from "@renderer/components/ui/button";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { qk } from "@renderer/query/keys";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { useSettingsStore } from "@renderer/store/settings-store";
import { fileNameOf, pickEpubFiles } from "./epub-drop";
import { useEpubDrop } from "./use-epub-drop";
import { DropOverlay } from "./DropOverlay";
import { BookCover } from "./BookCover";

interface ImportItem {
  filePath: string;
  name: string;
}

export function LibraryView() {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const openBook = useNavigationStore((s) => s.openBook);
  const openSettings = useSettingsStore((s) => s.setOpen);
  const books = useQuery({ queryKey: qk.library, queryFn: () => window.api.library.list() });

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

  // 删书：调既有 library:delete IPC（主进程级联删 DB + unlink epub 副本），成功后失效刷新书库 + toast。
  const deleteBook = useMutation({
    mutationFn: (b: BookSummaryDto) => window.api.library.delete({ bookId: b.id }),
    onSuccess: (_r, b) => {
      void qc.invalidateQueries({ queryKey: qk.library });
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
      const names = new Intl.ListFormat(i18n.language, { style: "narrow", type: "unit" }).format(
        ignored,
      );
      toast.warning(
        t("library.ignored", "已忽略 {{count}} 个非 ePub：{{names}}", {
          count: ignored.length,
          names,
        }),
      );
    }
    for (const f of r.failed) {
      toast.error(
        t("library.importFailed", "{{name}} 导入失败：{{error}}", { name: f.name, error: f.error }),
        { closeButton: true, duration: Infinity },
      );
    }
  };

  // 拖拽落点：过滤 epub → 取路径 → 批量导入；忽略项进 toast。
  const onFiles = (files: File[]) => {
    const { epubs, ignored } = pickEpubFiles(files);
    const items = epubs.map((f) => ({ filePath: window.api.library.pathForFile(f), name: f.name }));
    void runImport(
      items,
      ignored.map((f) => f.name),
    );
  };

  // 按钮导入：原生对话框取单个路径 → 同一批量通道。
  const onPick = async () => {
    const filePath = await window.api.library.pickEpub();
    if (!filePath) return;
    void runImport([{ filePath, name: fileNameOf(filePath) }], []);
  };

  const { isDragging, isOverZone, rootHandlers, zoneHandlers } = useEpubDrop(onFiles);

  return (
    <div
      {...rootHandlers}
      className="flex h-screen flex-col bg-background font-sans text-foreground"
    >
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-6">
        <h1 className="font-serif text-xl font-semibold">{t("library.title", "Marginalia")}</h1>
        <div className="flex items-center gap-2">
          <Button onClick={() => void onPick()} disabled={importBooks.isPending}>
            <FolderOpen />
            {importBooks.isPending
              ? t("library.importPending", "导入中…")
              : t("library.import", "导入 ePub")}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => openSettings(true)}
            aria-label={t("settings.title", "设置")}
            className="text-muted-foreground"
          >
            <Settings />
          </Button>
        </div>
      </header>

      <ScrollArea className="flex-1">
        <main className="p-6">
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
                {t("library.empty", "书库为空，点右上角「导入 ePub」或把 .epub 拖进窗口开始。")}
              </p>
            </div>
          )}
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-5">
            {books.data?.map((b) => (
              <li key={b.id}>
                <BookCover
                  book={b}
                  onOpen={() => openBook(b.id)}
                  onDelete={() => deleteBook.mutate(b)}
                />
              </li>
            ))}
          </ul>
        </main>
      </ScrollArea>

      {isDragging && <DropOverlay active={isOverZone} zoneHandlers={zoneHandlers} />}
    </div>
  );
}
