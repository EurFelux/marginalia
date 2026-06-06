import { afterEach, expect, test } from "vitest";
import { MutationObserver, onlineManager } from "@tanstack/react-query";
import { queryClient } from "./client";

// 所有 queryFn/mutationFn 都走 IPC 到主进程本地 SQLite,不经过网络;
// React Query 默认 networkMode "online" 会在 navigator.onLine=false 时
// 把它们整体 pause,导致断网时本地 db 数据永远取不到(设置页空白)。
// 回归:断网状态下 query 与 mutation 必须照常执行。

const raceTimeout = <T>(p: Promise<T>, label: string): Promise<T> => {
  p.catch(() => {}); // race 输掉后若被恢复/清理,避免 unhandled rejection
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(label)), 500)),
  ]);
};

afterEach(() => {
  onlineManager.setOnline(true);
  queryClient.clear();
});

test("断网时 query 仍执行(IPC 不依赖网络,不得被 pause)", async () => {
  onlineManager.setOnline(false);
  const data = await raceTimeout(
    queryClient.fetchQuery({ queryKey: ["offline-query"], queryFn: async () => "from-db" }),
    "query was paused while offline",
  );
  expect(data).toBe("from-db");
});

test("断网时 mutation 仍执行(本地写入不得被 pause)", async () => {
  onlineManager.setOnline(false);
  const observer = new MutationObserver(queryClient, { mutationFn: async () => "saved" });
  const result = await raceTimeout(observer.mutate(), "mutation was paused while offline");
  expect(result).toBe("saved");
});
