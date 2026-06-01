import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "#/lib/utils";

/** 自绘 macOS 式细滚动条：隐藏原生条，叠一个绝对定位 thumb，按 scroll 算高度/位置；
 *  滚动 / 悬停时淡入，停手 900ms 后淡出。零依赖、跟随主题。
 *  滚动区限高经 `viewportClassName`（Tailwind，如 `max-h-40`）。
 *  thumb 的 height/top/opacity 为运行时计算值，按规范属"必要"内联。 */
export function ScrollArea({
  children,
  className,
  viewportClassName,
}: {
  children: ReactNode;
  className?: string;
  viewportClassName?: string;
}) {
  const viewport = useRef<HTMLDivElement | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [thumb, setThumb] = useState<{ height: number; top: number } | null>(null);
  const [visible, setVisible] = useState(false);

  const measure = () => {
    const el = viewport.current;
    if (!el) return;
    const { clientHeight, scrollHeight, scrollTop } = el;
    if (scrollHeight <= clientHeight + 1) {
      setThumb(null);
      return;
    }
    const height = Math.max((clientHeight / scrollHeight) * clientHeight, 24);
    const top = (scrollTop / (scrollHeight - clientHeight)) * (clientHeight - height);
    setThumb({ height, top });
  };

  const reveal = () => {
    setVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setVisible(false), 900);
  };

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      className={cn("relative", className)}
      onMouseEnter={reveal}
      onMouseMove={reveal}
      onMouseLeave={() => {
        if (hideTimer.current) clearTimeout(hideTimer.current);
        setVisible(false);
      }}
    >
      <div
        ref={viewport}
        onScroll={() => {
          measure();
          reveal();
        }}
        className={cn("no-scrollbar overflow-y-auto", viewportClassName)}
      >
        {children}
      </div>
      {thumb && (
        <div
          className="pointer-events-none absolute right-1 z-10 w-1.5 rounded-full bg-foreground/35 transition-opacity duration-300"
          style={{ height: thumb.height, top: thumb.top, opacity: visible ? 1 : 0 }}
        />
      )}
    </div>
  );
}
