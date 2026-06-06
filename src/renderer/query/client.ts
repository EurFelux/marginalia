import { QueryClient } from "@tanstack/react-query";

/**
 * 适配本地 IPC（非网络）：不 focus 重验、本地确定性数据高 staleTime、失败不重试。
 * networkMode "always"：query/mutation 走 IPC 读写本地 db，不依赖网络；
 * 默认 "online" 会在断网时整体 pause，导致本地数据取不到、写入卡住。
 * 真正的网络请求都在主进程发起，失败时由主进程透传真实错误。
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: Number.POSITIVE_INFINITY,
      retry: false,
      networkMode: "always",
    },
    mutations: {
      networkMode: "always",
    },
  },
});
