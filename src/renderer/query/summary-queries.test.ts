// src/renderer/query/summary-queries.test.ts
import { describe, expect, it } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/query-core";
import { bookSummaryQuery, chapterSummaryQuery } from "@renderer/query/summary-queries";

/** 与 renderer 全局 client 同配置（staleTime=∞），证明工厂的 staleTime:0 能覆盖它。 */
function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { refetchOnWindowFocus: false, staleTime: Number.POSITIVE_INFINITY, retry: false },
    },
  });
}

const flush = () => new Promise((r) => setTimeout(r, 20));

/** 模拟 interval 回调入参：只有 state.data 被读取。 */
const q = (data: unknown) => ({ state: { data } }) as never;

describe("chapterSummaryQuery", () => {
  it("refetches on re-activation instead of serving the cached snapshot (stale-pending bug)", async () => {
    // 回归：摘要是主进程后台推进的派生状态。全局 staleTime=∞ 曾使缓存的 pending 快照
    // 在滑走再滑回（observer 重挂）时被当作新鲜数据直接展示，且 refetchInterval 计时器
    // 只在 fetch 后调度——纯缓存命中永不轮询 → UI 永久冻结在「摘要待生成」。
    const client = makeClient();
    let server = { status: "pending", summary: null as string | null };
    const options = () =>
      client.defaultQueryOptions({
        ...chapterSummaryQuery("b1", "c1"),
        queryFn: () => Promise.resolve({ ...server }),
      });

    const obs1 = new QueryObserver(client, options());
    const off1 = obs1.subscribe(() => {});
    await flush();
    expect(obs1.getCurrentResult().data?.status).toBe("pending");
    off1();
    obs1.destroy(); // 用户滑走，observer 卸载

    server = { status: "ready", summary: "done" }; // 摘要在后台生成完成

    const obs2 = new QueryObserver(client, options()); // 用户滑回，重挂
    const off2 = obs2.subscribe(() => {});
    await flush();
    expect(obs2.getCurrentResult().data?.status).toBe("ready");
    off2();
    obs2.destroy();
    client.clear();
  });

  it("polls while transient (pending/generating/error) and stops at terminal states", () => {
    const { refetchInterval } = chapterSummaryQuery("b1", "c1");
    expect(refetchInterval(q({ status: "pending", summary: null }))).toBe(2500);
    expect(refetchInterval(q({ status: "generating", summary: null }))).toBe(2500);
    // query error 后 data=undefined：曾返回 false 永久停摆，现在持续重试以自愈瞬态错误
    expect(refetchInterval(q(undefined))).toBe(2500);
    expect(refetchInterval(q({ status: "ready", summary: "s" }))).toBe(false);
    expect(refetchInterval(q({ status: "unavailable", summary: null }))).toBe(false);
  });
});

describe("bookSummaryQuery", () => {
  it("overrides the global staleTime so re-activation refetches", () => {
    expect(bookSummaryQuery("b1").staleTime).toBe(0);
  });

  it("fast-polls only while generating (streams the partial), no polling otherwise", () => {
    const { refetchInterval } = bookSummaryQuery("b1");
    expect(refetchInterval(q({ status: "generating", summary: "par" }))).toBe(400);
    expect(refetchInterval(q({ status: "pending", summary: null }))).toBe(false);
    expect(refetchInterval(q({ status: "ready", summary: "s" }))).toBe(false);
    expect(refetchInterval(q(undefined))).toBe(false);
  });
});
