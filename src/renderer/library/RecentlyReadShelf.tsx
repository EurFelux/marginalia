import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { qk } from "@renderer/query/keys";
import { createLogger } from "@renderer/logger";
import { CoverImage } from "./CoverImage";

const log = createLogger("library");

/**
 * 「继续阅读」shelf（#48 spec §6.1）：最近读过的 ≤3 本，信息卡带进度。
 * 无阅读记录（或查询失败）整个隐藏；staleTime 0——读完书返回时重挂载即 refetch。
 * shelf 是视图不是分区：同一本书同时出现在 shelf 与下方网格属预期。
 */
export function RecentlyReadShelf({ onOpen }: { onOpen: (bookId: string) => void }) {
  const { t } = useTranslation();
  const recent = useQuery({
    queryKey: qk.recentlyRead,
    queryFn: () => window.api.library.recentlyRead(),
    staleTime: 0,
  });

  // 查询失败 → 隐藏 + warn（优雅吞错必须留 warn）。
  useEffect(() => {
    if (recent.error) log.warn("recently read query failed", recent.error);
  }, [recent.error]);

  if (!recent.data?.length) return null;

  return (
    <section className="mb-8">
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {t("library.continueReading", "继续阅读")}
      </h2>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {recent.data.map((b) => (
          <li key={b.id}>
            <button
              onClick={() => onOpen(b.id)}
              className="flex w-full items-center gap-3 rounded-lg border border-border bg-card p-3 text-left shadow-sm transition-shadow hover:shadow-md"
            >
              <div className="w-12 shrink-0 overflow-hidden rounded">
                <CoverImage book={b} withText={false} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-serif text-sm font-semibold">{b.title ?? b.id}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {b.author ?? t("library.unknownAuthor", "未知作者")}
                </p>
                {b.percent != null && (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                      {/* 进度条宽度是运行时计算值——内联 style 合规例外 */}
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${Math.round(b.percent * 100)}%` }}
                      />
                    </div>
                    <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
                      {Math.round(b.percent * 100)}%
                    </span>
                  </div>
                )}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
