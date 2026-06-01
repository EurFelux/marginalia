import { QueryClient } from "@tanstack/react-query";

/** 适配本地 IPC（非网络）：不 focus 重验、本地确定性数据高 staleTime、失败不重试。 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: Number.POSITIVE_INFINITY,
      retry: false,
    },
  },
});
