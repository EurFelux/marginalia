import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionCancel, PermissionRequest } from "@shared/permissions";
import {
  connectPermissionRequests,
  respondToPermission,
  usePermissionStore,
  type PermissionApi,
} from "@renderer/store/permission-store";

function request(over: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    requestId: "q1",
    conversationId: "c1",
    toolCallId: "call-1",
    tool: "bash",
    command: "ls -la",
    cwd: "/ws",
    simple: true,
    suggestedPrefix: "ls",
    ...over,
  };
}

function fakeApi() {
  let onRequest: ((r: PermissionRequest) => void) | undefined;
  let onCancel: ((c: PermissionCancel) => void) | undefined;
  const api: PermissionApi = {
    respond: vi.fn(async () => ({ ok: true })),
    onRequest: (cb) => ((onRequest = cb), () => (onRequest = undefined)),
    onCancel: (cb) => ((onCancel = cb), () => (onCancel = undefined)),
  };
  return {
    api,
    push: (r: PermissionRequest) => onRequest?.(r),
    cancel: (c: PermissionCancel) => onCancel?.(c),
    subscribed: () => onRequest !== undefined && onCancel !== undefined,
  };
}

beforeEach(() => usePermissionStore.setState({ pending: {} }));

describe("permission store", () => {
  it("stores pushed requests by toolCallId and drops them on cancel", () => {
    const main = fakeApi();
    const off = connectPermissionRequests(main.api);
    main.push(request());
    main.push(request({ requestId: "q2", toolCallId: "call-2", command: "pwd" }));
    expect(Object.keys(usePermissionStore.getState().pending)).toEqual(["call-1", "call-2"]);

    main.cancel({ requestId: "q1" });
    expect(Object.keys(usePermissionStore.getState().pending)).toEqual(["call-2"]);

    off();
    expect(main.subscribed()).toBe(false);
  });

  it("removes a request once main accepts the answer, and when it is already gone", async () => {
    const main = fakeApi();
    usePermissionStore.getState().add(request());
    usePermissionStore.getState().add(request({ requestId: "q2", toolCallId: "call-2" }));

    await respondToPermission({ requestId: "q1", choice: "once" }, main.api);
    expect(main.api.respond).toHaveBeenCalledWith({ requestId: "q1", choice: "once" });

    vi.mocked(main.api.respond).mockResolvedValueOnce({ ok: false });
    await respondToPermission({ requestId: "q2", choice: "deny" }, main.api);
    expect(usePermissionStore.getState().pending).toEqual({});
  });

  it("keeps the request when main rejects the answer", async () => {
    const main = fakeApi();
    usePermissionStore.getState().add(request());
    vi.mocked(main.api.respond).mockRejectedValueOnce(new Error("bad prefix"));
    await expect(
      respondToPermission({ requestId: "q1", choice: "always", prefix: "lsx" }, main.api),
    ).rejects.toThrow("bad prefix");
    expect(Object.keys(usePermissionStore.getState().pending)).toEqual(["call-1"]);
  });
});
