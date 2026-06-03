import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BookOpen, FolderOpen, Settings } from "lucide-react";
import type { BookSummaryDto } from "@shared/library";
import { Button } from "@renderer/components/ui/button";
import { qk } from "@renderer/query/keys";
import { useReaderStore } from "@renderer/store/reader-store";
import { useSettingsStore } from "@renderer/store/settings-store";
import { fileNameOf, pickEpubFiles } from "./epub-drop";
import { useEpubDrop } from "./use-epub-drop";
import { DropOverlay } from "./DropOverlay";

interface ImportItem {
  filePath: string;
  name: string;
}

export function LibraryView() {
  const qc = useQueryClient();
  const openBook = useReaderStore((s) => s.openBook);
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

  // 即时 toast 反馈：新增 / 已在库（幂等复用）/ 忽略非 epub / 失败（透传主进程真实错误，不自动消失）。
  const runImport = async (items: ImportItem[], ignored: string[]) => {
    if (items.length === 0 && ignored.length === 0) return;
    const existing = new Set(books.data?.map((b) => b.id) ?? []);
    const r = items.length > 0 ? await importBooks.mutateAsync(items) : { ok: [], failed: [] };
    const added = r.ok.filter((b) => !existing.has(b.id)).length;
    const duplicate = r.ok.length - added;

    if (added > 0) toast.success(`已导入 ${added} 本`);
    if (duplicate > 0) toast.info(`${duplicate} 本已在书库`);
    if (ignored.length > 0) {
      toast.warning(`已忽略 ${ignored.length} 个非 ePub：${ignored.join("、")}`);
    }
    for (const f of r.failed) {
      toast.error(`${f.name} 导入失败：${f.error}`, { closeButton: true, duration: Infinity });
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
        <h1 className="font-serif text-xl font-semibold">Marginalia</h1>
        <div className="flex items-center gap-2">
          <Button onClick={() => void onPick()} disabled={importBooks.isPending}>
            <FolderOpen />
            {importBooks.isPending ? "导入中…" : "导入 ePub"}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => openSettings(true)}
            aria-label="设置"
            className="text-muted-foreground"
          >
            <Settings />
          </Button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-6">
        {books.isPending && <p className="text-sm text-muted-foreground">加载书库…</p>}
        {books.isError && <p className="text-sm text-destructive">读取书库失败</p>}
        {books.data?.length === 0 && (
          <div className="mt-20 text-center text-muted-foreground">
            <BookOpen className="mx-auto mb-3 size-10 opacity-40" />
            <p className="text-sm">书库为空，点右上角「导入 ePub」或把 .epub 拖进窗口开始。</p>
          </div>
        )}
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {books.data?.map((b) => (
            <li key={b.id}>
              <button
                onClick={() => openBook(b.id)}
                className="flex w-full items-center gap-3 rounded-xl border border-border bg-card/60 p-3 text-left hover:bg-muted"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                  <BookOpen className="size-5" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{b.title ?? b.id}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {b.author ?? "未知作者"}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </main>

      {isDragging && <DropOverlay active={isOverZone} zoneHandlers={zoneHandlers} />}
    </div>
  );
}
