import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { createLogger } from "@renderer/logger";
import { qk } from "@renderer/query/keys";
import { createEpubBook, type EpubBook } from "./epub-book";

const log = createLogger("epub");

export interface EpubSession {
  book: EpubBook | null;
  /** spine 物理顺序的 href（book 就绪后派生）；book 未就绪 / 非 epub 时为空数组。 */
  spineHrefs: string[];
  parseError: string | null;
  bytesError: boolean;
}

const EpubSessionContext = createContext<EpubSession | null>(null);

export function useEpubSession(): EpubSession {
  const ctx = useContext(EpubSessionContext);
  if (!ctx) throw new Error("useEpubSession must be used within EpubSessionProvider");
  return ctx;
}

/**
 * book 实例归 ReaderView 范围状态：EpubReader 与 AnnotationsList 都从这里消费。
 * 仅 ePub 书创建 book（enabled=false 时 PDF：book=null、spineHrefs=[]，PdfReader 不消费本 context）。
 */
export function EpubSessionProvider({
  bookId,
  enabled,
  children,
}: {
  bookId: string;
  enabled: boolean;
  children: ReactNode;
}) {
  const [book, setBook] = useState<EpubBook | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const bytes = useQuery({
    queryKey: qk.bookBytes(bookId),
    queryFn: () => window.api.library.readBookBytes({ bookId }),
    staleTime: Infinity,
    enabled,
  });

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
        if (alive) {
          log.error("epub parse failed", err);
          setParseError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      alive = false;
      created?.destroy();
      setBook(null);
      setParseError(null); // 换书/重解析时清旧错误，避免新书加载前短暂残留上一本的 parseError
    };
  }, [bytes.data]);

  const spineHrefs = book
    ? Array.from({ length: book.count }, (_, i) => book.hrefAtIndex(i) ?? "")
    : [];

  return (
    <EpubSessionContext.Provider
      value={{ book, spineHrefs, parseError, bytesError: bytes.isError }}
    >
      {children}
    </EpubSessionContext.Provider>
  );
}
