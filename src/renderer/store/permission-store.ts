// 挂起的工具审批请求（spec 2026-10-03-bash-skills-permissions-design §5.6）。
// 主进程推来的请求按 toolCallId 存，bash 终端块（#121）凭自己的 toolCallId 取出并渲染审批操作栏。
import { useEffect } from "react";
import { create } from "zustand";
import type {
  PermissionCancel,
  PermissionRequest,
  PermissionRespondInput,
  PermissionRespondResult,
} from "@shared/permissions";

interface PermissionState {
  /** toolCallId → 挂起的审批请求。 */
  pending: Record<string, PermissionRequest>;
  add: (request: PermissionRequest) => void;
  remove: (requestId: string) => void;
}

export const usePermissionStore = create<PermissionState>((set) => ({
  pending: {},
  add: (request) => set((s) => ({ pending: { ...s.pending, [request.toolCallId]: request } })),
  remove: (requestId) =>
    set((s) => ({
      pending: Object.fromEntries(
        Object.entries(s.pending).filter(([, r]) => r.requestId !== requestId),
      ),
    })),
}));

/** window.api.permissions 里本模块用到的部分（测试注入假实现）。 */
export interface PermissionApi {
  respond: (input: PermissionRespondInput) => Promise<PermissionRespondResult>;
  onRequest: (cb: (request: PermissionRequest) => void) => () => void;
  onCancel: (cb: (cancel: PermissionCancel) => void) => () => void;
}

/** 订阅主进程的请求与撤销；返回退订函数。 */
export function connectPermissionRequests(api: PermissionApi): () => void {
  const { add, remove } = usePermissionStore.getState();
  const offRequest = api.onRequest(add);
  const offCancel = api.onCancel(({ requestId }) => remove(requestId));
  return () => {
    offRequest();
    offCancel();
  };
}

/**
 * 答复一条请求。主进程收下（ok）或请求已失效（!ok）都从表里移除；主进程拒收时抛错
 * （前缀不合法、规则写入失败），请求留在表里，用户可以重选。
 */
export async function respondToPermission(
  input: PermissionRespondInput,
  api: Pick<PermissionApi, "respond"> = window.api.permissions,
): Promise<void> {
  await api.respond(input);
  usePermissionStore.getState().remove(input.requestId);
}

/** App 挂载时调用一次：把主进程推送接进 store。 */
export function usePermissionRequests(): void {
  useEffect(() => {
    if (typeof window === "undefined" || !window.api?.permissions) return;
    return connectPermissionRequests(window.api.permissions);
  }, []);
}
