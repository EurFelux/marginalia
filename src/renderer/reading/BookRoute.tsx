import { useQuery } from "@tanstack/react-query";
import { qk } from "@renderer/query/keys";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { ReaderView } from "@renderer/reader/ReaderView";
import { resolveBookDestination } from "@renderer/reading/route-state";
import { ReadingStartView } from "@renderer/reading/ReadingStartView";
import { ReadingReportView } from "@renderer/reading/ReadingReportView";

export function BookRoute() {
  const bookId = useNavigationStore((s) => s.currentBookId);
  const mode = useNavigationStore((s) => s.bookMode);
  const book = useQuery({
    queryKey: qk.book(bookId ?? ""),
    queryFn: () => window.api.library.get({ bookId: bookId! }),
    enabled: bookId != null,
  });
  if (!bookId) return <RouteMessage>请选择一本书。</RouteMessage>;
  if (book.isPending) return <RouteMessage>载入书籍中…</RouteMessage>;
  if (book.isError) return <RouteMessage>无法读取这本书。</RouteMessage>;
  if (!book.data) return <RouteMessage>这本书不存在。</RouteMessage>;
  switch (resolveBookDestination(book.data.readingState, mode)) {
    case "start":
      return <ReadingStartView book={book.data} />;
    case "reader-active":
      return <ReaderView mode="active" />;
    case "reader-reference":
      return <ReaderView mode="reference" />;
    case "report":
      return <ReadingReportView book={book.data} />;
  }
}

function RouteMessage({ children }: { children: string }) {
  return (
    <main className="flex h-screen items-center justify-center text-muted-foreground">
      {children}
    </main>
  );
}
