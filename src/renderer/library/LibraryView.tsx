import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, FolderOpen, Settings } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { qk } from "@renderer/query/keys";
import { useReaderStore } from "@renderer/store/reader-store";
import { useSettingsStore } from "@renderer/store/settings-store";

export function LibraryView() {
  const qc = useQueryClient();
  const openBook = useReaderStore((s) => s.openBook);
  const openSettings = useSettingsStore((s) => s.setOpen);
  const books = useQuery({ queryKey: qk.library, queryFn: () => window.api.library.list() });

  const importBook = useMutation({
    mutationFn: async () => {
      const filePath = await window.api.library.pickEpub();
      if (!filePath) return null;
      return window.api.library.import({ filePath });
    },
    onSuccess: (book) => {
      if (book) void qc.invalidateQueries({ queryKey: qk.library });
    },
  });

  return (
    <div className="flex h-screen flex-col bg-background font-sans text-foreground">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-6">
        <h1 className="font-serif text-xl font-semibold">Marginalia</h1>
        <div className="flex items-center gap-2">
          <Button onClick={() => importBook.mutate()} disabled={importBook.isPending}>
            <FolderOpen />
            {importBook.isPending ? "导入中…" : "导入 ePub"}
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
        {importBook.isError && (
          <p className="mb-4 text-sm text-destructive">
            导入失败：{(importBook.error as Error).message}
          </p>
        )}
        {books.isPending && <p className="text-sm text-muted-foreground">加载书库…</p>}
        {books.isError && <p className="text-sm text-destructive">读取书库失败</p>}
        {books.data?.length === 0 && (
          <div className="mt-20 text-center text-muted-foreground">
            <BookOpen className="mx-auto mb-3 size-10 opacity-40" />
            <p className="text-sm">书库为空，点右上角「导入 ePub」开始。</p>
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
    </div>
  );
}
