import { useQuery } from "@tanstack/react-query";
import { qk } from "@renderer/query/keys";

export function App() {
  const library = useQuery({ queryKey: qk.library, queryFn: () => window.api.library.list() });

  return (
    <div className="flex h-screen bg-background font-sans text-foreground">
      <aside className="w-64 shrink-0 border-r border-border p-4">
        <h1 className="font-serif text-xl font-semibold">Marginalia</h1>
        <p className="mt-1 text-sm text-muted-foreground">书库</p>
        {library.isPending && <p className="mt-4 text-sm">加载中…</p>}
        {library.isError && <p className="mt-4 text-sm text-destructive">读取书库失败</p>}
        <ul className="mt-4 space-y-1">
          {library.data?.map((b) => (
            <li key={b.id} className="truncate text-sm">
              {b.title ?? b.id}
            </li>
          ))}
          {library.data?.length === 0 && (
            <li className="text-sm text-muted-foreground">（空——导入功能见 Plan 3）</li>
          )}
        </ul>
      </aside>
      <main className="flex-1 p-8">
        <p className="font-serif text-lg">渲染层地基就绪（S1）。</p>
      </main>
    </div>
  );
}
