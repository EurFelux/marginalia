import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { EpubCFI } from "epubjs";
import { createLogger } from "@renderer/logger";
import { qk } from "@renderer/query/keys";
import type { ChapterRefDto } from "@shared/library";
import { type AnchorBoundary } from "./chapter-id-at-cfi";
import { basename } from "./chapter-id-by-href";
import { createEpubBook, type EpubBook } from "./epub-book";

const log = createLogger("epub");

export interface EpubSession {
  book: EpubBook | null;
  /** spine 物理顺序的 href（book 就绪后派生）；book 未就绪 / 非 epub 时为空数组。 */
  spineHrefs: string[];
  anchorBoundaries: AnchorBoundary[];
  parseError: string | null;
  /** app 自有副本缺失（safe-return ok:false）——EpubReader 据此挂缺失面板。 */
  bytesMissing: boolean;
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
  const [anchorBoundaries, setAnchorBoundaries] = useState<AnchorBoundary[]>([]);
  const chapters = useQuery({
    queryKey: qk.chapters(bookId),
    queryFn: () => window.api.content.chapters({ bookId }),
    staleTime: Infinity,
    enabled,
  });

  const bytes = useQuery({
    queryKey: qk.bookBytes(bookId),
    queryFn: () => window.api.library.readBookBytes({ bookId }),
    staleTime: Infinity,
    enabled,
  });

  useEffect(() => {
    if (!bytes.data?.ok) return;
    const fileBytes = bytes.data.data;
    let alive = true;
    let created: EpubBook | null = null;
    setParseError(null);
    createEpubBook(fileBytes)
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

  // 共享 href（锚点切章）的章节需 anchor 级边界 CFI 才能归属标注。开书后异步预计算：
  // 渲染相关 section、为每个锚点章生成起点 CFI，按 CFI 升序存。未就绪时侧栏退化 href 级。
  useEffect(() => {
    if (!book || !chapters.data) {
      setAnchorBoundaries([]);
      return;
    }
    const chs = chapters.data;
    let alive = true;
    void (async () => {
      try {
        const byBase = new Map<string, ChapterRefDto[]>();
        for (const c of chs) {
          const base = basename(c.href);
          const list = byBase.get(base) ?? [];
          list.push(c);
          byBase.set(base, list);
        }
        const out: AnchorBoundary[] = [];
        for (const group of byBase.values()) {
          if (group.length <= 1) continue;
          const withAnchor = group.filter((c) => c.anchor);
          if (withAnchor.length === 0) continue;
          const index = book.indexOfHref(group[0]!.href);
          if (index < 0) continue;
          for (const c of withAnchor) {
            const cfi = await book.anchorCfi(index, c.anchor!);
            if (cfi) out.push({ chapterId: c.id, cfi });
          }
        }
        const epub = new EpubCFI();
        out.sort((a, b) => epub.compare(a.cfi, b.cfi));
        if (alive) setAnchorBoundaries(out);
      } catch (err) {
        log.warn("anchor boundary precompute failed", err);
        if (alive) setAnchorBoundaries([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [book, chapters.data]);

  const spineHrefs = book
    ? Array.from({ length: book.count }, (_, i) => book.hrefAtIndex(i) ?? "")
    : [];

  return (
    <EpubSessionContext.Provider
      value={{
        book,
        spineHrefs,
        anchorBoundaries,
        parseError,
        bytesMissing: bytes.data?.ok === false,
        bytesError: bytes.isError,
      }}
    >
      {children}
    </EpubSessionContext.Provider>
  );
}
