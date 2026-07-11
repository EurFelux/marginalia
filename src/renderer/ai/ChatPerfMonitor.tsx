import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * 临时 dev-only 性能监控：测量 AI 消息列表的渲染与滚动开销。
 *
 * 用法：在 AIPanel 的 ScrollArea 附近挂载：
 *   <ChatPerfMonitor messages={messages} />
 *
 * 会在 DevTools console 每 5 秒输出一次汇总，并在面板右上角显示一个 mini overlay。
 */
type AnyMessage = { id: string; role: string };

interface PerfSnapshot {
  messageCount: number;
  lastRenderMs: number | null;
  longTasks: number;
  longTaskTotalMs: number;
  maxLongTaskMs: number;
  scrollFrames: number;
  scrollEvents: number;
  avgScrollFps: number | null;
}

export function ChatPerfMonitor({ messages }: { messages: AnyMessage[] }) {
  const [snapshot, setSnapshot] = useState<PerfSnapshot>({
    messageCount: messages.length,
    lastRenderMs: null,
    longTasks: 0,
    longTaskTotalMs: 0,
    maxLongTaskMs: 0,
    scrollFrames: 0,
    scrollEvents: 0,
    avgScrollFps: null,
  });

  const lastRenderStartRef = useRef<number | null>(null);
  const longTaskStatsRef = useRef({ count: 0, total: 0, max: 0 });
  const scrollStatsRef = useRef({ frames: 0, events: 0, lastEventTime: 0 });
  const reportIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 1. 测量消息变化 → layout/paint 完成的耗时。
  // 用 useLayoutEffect 捕获 DOM 已更新，再用 rAF 捕获首次 paint。
  useLayoutEffect(() => {
    const start = lastRenderStartRef.current ?? performance.now();
    const count = messages.length;
    requestAnimationFrame(() => {
      const end = performance.now();
      setSnapshot((prev) => ({
        ...prev,
        messageCount: count,
        lastRenderMs: Math.round(end - start),
      }));
    });
  }, [messages]);

  useEffect(() => {
    lastRenderStartRef.current = performance.now();
  }, [messages]);

  // 2. PerformanceObserver 监听 longtask（>50ms 主线程阻塞）。
  useEffect(() => {
    if (typeof PerformanceObserver === "undefined") return;
    if (!("PerformanceLongTaskTiming" in window)) return;

    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskStatsRef.current.count += 1;
        longTaskStatsRef.current.total += entry.duration;
        longTaskStatsRef.current.max = Math.max(longTaskStatsRef.current.max, entry.duration);
      }
      setSnapshot((prev) => ({
        ...prev,
        longTasks: longTaskStatsRef.current.count,
        longTaskTotalMs: Math.round(longTaskStatsRef.current.total),
        maxLongTaskMs: Math.round(longTaskStatsRef.current.max),
      }));
    });

    try {
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // 某些 Electron/DevTools 环境不支持 longtask
    }

    return () => observer.disconnect();
  }, []);

  // 3. 滚动 FPS 计数器：用户滚动时，连续 rAF 计数；300ms 静止后结算一次。
  useEffect(() => {
    const viewport = document.querySelector(".ai-messages-viewport") as HTMLElement | null;
    if (!viewport) return;

    const state = {
      counting: false,
      frameCount: 0,
      rafId: null as number | null,
      timeoutId: null as ReturnType<typeof setTimeout> | null,
    };

    const stop = () => {
      if (state.rafId) cancelAnimationFrame(state.rafId);
      state.counting = false;
      state.rafId = null;
    };

    const tick = () => {
      state.frameCount += 1;
      state.rafId = requestAnimationFrame(tick);
    };

    const flush = () => {
      scrollStatsRef.current.frames += state.frameCount;
      const avg =
        scrollStatsRef.current.events > 0
          ? Math.round((scrollStatsRef.current.frames / scrollStatsRef.current.events) * 10) / 10
          : null;
      setSnapshot((prev) => ({
        ...prev,
        scrollFrames: scrollStatsRef.current.frames,
        scrollEvents: scrollStatsRef.current.events,
        avgScrollFps: avg,
      }));
      stop();
    };

    const onScroll = () => {
      scrollStatsRef.current.events += 1;
      scrollStatsRef.current.lastEventTime = performance.now();
      if (!state.counting) {
        state.counting = true;
        state.frameCount = 0;
        state.rafId = requestAnimationFrame(tick);
      }
      if (state.timeoutId) clearTimeout(state.timeoutId);
      state.timeoutId = setTimeout(() => {
        if (performance.now() - scrollStatsRef.current.lastEventTime >= 280) {
          flush();
        }
      }, 300);
    };

    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      viewport.removeEventListener("scroll", onScroll);
      if (state.timeoutId) clearTimeout(state.timeoutId);
      stop();
    };
  }, []);

  // 4. 每 5 秒向 console 输出一次结构化报告。
  useEffect(() => {
    reportIntervalRef.current = setInterval(() => {
      // eslint-disable-next-line no-console
      console.log("[ChatPerf]", JSON.stringify(snapshot));
    }, 5000);
    return () => {
      if (reportIntervalRef.current) clearInterval(reportIntervalRef.current);
    };
  }, [snapshot]);

  return (
    <div className="pointer-events-none fixed right-3 top-14 z-50 rounded-md border border-border bg-background/90 px-2 py-1 text-[10px] tabular-nums text-foreground shadow-sm backdrop-blur">
      <div>msgs: {snapshot.messageCount}</div>
      <div>render: {snapshot.lastRenderMs ?? "-"} ms</div>
      <div>
        long: {snapshot.longTasks} / {snapshot.longTaskTotalMs} ms
      </div>
      <div>max long: {snapshot.maxLongTaskMs} ms</div>
      <div>scroll fps: {snapshot.avgScrollFps ?? "-"}</div>
    </div>
  );
}
