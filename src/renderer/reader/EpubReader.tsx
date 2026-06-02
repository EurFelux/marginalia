import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { VirtualDocs, type VirtualDocsHandle } from "@marginalia/virtual-docs";
import { qk } from "../query/keys";
import { createEpubBook, type EpubBook } from "./epub-book";

interface Props {
  bookId: string;
}

export function EpubReader({ bookId }: Props) {
  const vRef = useRef<VirtualDocsHandle | null>(null);
  const [book, setBook] = useState<EpubBook | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const bytes = useQuery({
    queryKey: qk.epubBytes(bookId),
    queryFn: () => window.api.library.readEpubBytes({ bookId }),
    staleTime: Infinity,
  });

  // 字节就绪 → 解析为 EpubBook（解析失败显错误态，不崩）。
  useEffect(() => {
    if (!bytes.data) return;
    let alive = true;
    let created: EpubBook | null = null;
    setParseError(null);
    createEpubBook(bytes.data)
      .then((b) => {
        if (!alive) {
          b.destroy();
          return;
        }
        created = b;
        setBook(b);
      })
      .catch((err: unknown) => {
        if (alive) setParseError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
      created?.destroy();
      setBook(null);
    };
  }, [bytes.data]);

  if (bytes.isError) {
    return <ReaderError message="无法读取此书的文件。" />;
  }
  if (parseError) {
    return <ReaderError message={`无法渲染此书：${parseError}`} />;
  }
  if (!book) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">载入中…</div>
    );
  }

  return (
    <div className="h-full">
      <VirtualDocs ref={vRef} count={book.count} loadSection={book.loadSection} />
    </div>
  );
}

function ReaderError({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
      <p>{message}</p>
    </div>
  );
}
