import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Search } from "lucide-react";
import type { BookSearchHit } from "@shared/search";
import { MAX_SEARCH_HITS } from "@shared/search";
import { cn } from "@renderer/lib/utils";
import { Button } from "@renderer/components/ui/button";
import { Input } from "@renderer/components/ui/input";
import { KbdGroup, Kbd, ModKey } from "@renderer/components/ui/kbd";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { qk } from "@renderer/query/keys";
import { useSearchStore } from "@renderer/store/search-store";

const DEBOUNCE_MS = 250;

/** 连续命中按章节分组（PDF 无章节时按页）。 */
function groupKey(hit: BookSearchHit): string {
  if (hit.chapterId) return `ch:${hit.chapterId}`;
  return hit.target.format === "pdf" ? `page:${hit.target.page}` : "none";
}

export function SearchPanel({ bookId }: { bookId: string }) {
  const { t } = useTranslation();
  const query = useSearchStore((s) => s.query);
  const setQuery = useSearchStore((s) => s.setQuery);
  const result = useSearchStore((s) => s.result);
  const activeIndex = useSearchStore((s) => s.activeIndex);
  const focusNonce = useSearchStore((s) => s.focusNonce);
  const setResult = useSearchStore((s) => s.setResult);
  const activate = useSearchStore((s) => s.activate);
  const step = useSearchStore((s) => s.step);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef(new Map<number, HTMLButtonElement>());

  const [debounced, setDebounced] = useState(query.trim());
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const search = useQuery({
    queryKey: qk.search(bookId, debounced),
    queryFn: () => window.api.content.search({ bookId, query: debounced }),
    enabled: debounced.length > 0,
    staleTime: Infinity,
  });

  // 结果写进 store 供阅读器高亮 / 跳转。面板随标签页切换重挂时，同一份结果不得重置当前命中。
  useEffect(() => {
    const s = useSearchStore.getState();
    const next = debounced.length === 0 ? null : (search.data ?? null);
    if (debounced.length > 0 && !search.data) return;
    if (s.bookId === bookId && s.resultQuery === debounced && s.result === next) return;
    setResult(bookId, debounced, next);
  }, [bookId, debounced, search.data, setResult]);

  useEffect(() => {
    if (focusNonce === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusNonce]);

  useEffect(() => {
    if (activeIndex === null) return;
    rowRefs.current.get(activeIndex)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (query) setQuery("");
      else inputRef.current?.blur();
    }
  };

  const hits = result?.kind === "ok" && result === search.data ? result.hits : [];
  const settled = debounced.length > 0 && debounced === query.trim() && !search.isFetching;
  const count =
    result?.kind === "ok" && hits.length > 0
      ? `${activeIndex === null ? "" : `${activeIndex + 1} / `}${hits.length}${result.truncated ? "+" : ""}`
      : null;

  const status = (() => {
    if (query.trim().length === 0)
      return (
        <div className="space-y-2 p-4 text-center text-xs text-muted-foreground">
          <p>{t("reader.search.hint", "在整本书中查找文字")}</p>
          <KbdGroup>
            <ModKey />
            <Kbd>F</Kbd>
          </KbdGroup>
        </div>
      );
    if (search.isError)
      return (
        <p className="p-3 text-xs text-destructive">
          {t("reader.search.error", "搜索失败：{{message}}", {
            message: search.error instanceof Error ? search.error.message : String(search.error),
          })}
        </p>
      );
    if (search.data?.kind === "no-text-layer")
      return (
        <p className="p-4 text-center text-xs text-muted-foreground">
          {t("reader.search.noTextLayer", "这本 PDF 是扫描版，没有文本层，无法搜索。")}
        </p>
      );
    if (!settled && hits.length === 0)
      return (
        <p className="p-4 text-center text-xs text-muted-foreground">
          {t("reader.search.searching", "搜索中…")}
        </p>
      );
    if (settled && hits.length === 0)
      return (
        <p className="p-4 text-center text-xs text-muted-foreground">
          {t("reader.search.noResults", "没有找到「{{query}}」", { query: debounced })}
        </p>
      );
    return null;
  })();

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-1.5 border-b border-border p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("reader.search.placeholder", "搜索本书")}
            aria-label={t("reader.search.placeholder", "搜索本书")}
            className="h-8 pr-24 pl-7 text-sm"
            maxLength={200}
          />
          <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5">
            {count && (
              <span className="px-1 text-[11px] text-muted-foreground tabular-nums">{count}</span>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("reader.search.previous", "上一个")}
              disabled={hits.length === 0}
              onClick={() => step(-1)}
            >
              <ChevronUp className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("reader.search.next", "下一个")}
              disabled={hits.length === 0}
              onClick={() => step(1)}
            >
              <ChevronDown className="size-3.5" />
            </Button>
          </div>
        </div>
        {result?.kind === "ok" && result.truncated && hits.length > 0 && (
          <p className="px-1 text-[11px] text-muted-foreground">
            {t("reader.search.truncated", "只显示前 {{count}} 条结果", { count: MAX_SEARCH_HITS })}
          </p>
        )}
      </div>
      {status ?? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="p-2">
            {hits.map((hit, i) => {
              const newGroup = i === 0 || groupKey(hits[i - 1]!) !== groupKey(hit);
              const page = hit.target.format === "pdf" ? hit.target.page : null;
              return (
                <div key={i}>
                  {newGroup && (
                    <div className="truncate px-1.5 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">
                      {hit.chapterTitle ??
                        (page !== null
                          ? t("reader.search.page", "第 {{page}} 页", { page })
                          : t("reader.search.noChapter", "正文"))}
                    </div>
                  )}
                  <button
                    type="button"
                    ref={(el) => {
                      if (el) rowRefs.current.set(i, el);
                      else rowRefs.current.delete(i);
                    }}
                    onClick={() => activate(i)}
                    className={cn(
                      "block w-full rounded-md px-1.5 py-1 text-start text-xs leading-relaxed text-muted-foreground hover:bg-accent",
                      i === activeIndex && "bg-accent text-foreground",
                    )}
                  >
                    {page !== null && hit.chapterTitle && (
                      <span className="me-1 text-[10px] text-muted-foreground/70">
                        {t("reader.search.pageShort", "p.{{page}}", { page })}
                      </span>
                    )}
                    <span className="line-clamp-3">
                      {hit.snippet.before}
                      <strong className="font-semibold text-foreground">{hit.snippet.match}</strong>
                      {hit.snippet.after}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
