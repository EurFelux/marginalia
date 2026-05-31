import { describe, expect, it } from "vitest";
import { appGetInfoResult, IPC, pingInput } from "@shared/ipc";

describe("ipc schemas", () => {
  it("exposes channel names", () => {
    expect(IPC.appGetInfo).toBe("app:get-info");
    expect(IPC.ping).toBe("ping");
  });

  it("ping input rejects non-string msg", () => {
    expect(pingInput.safeParse({ msg: 123 }).success).toBe(false);
    expect(pingInput.safeParse({ msg: "hi" }).success).toBe(true);
  });

  it("app info result requires version + bookCount", () => {
    expect(appGetInfoResult.safeParse({ version: "1.0.0", bookCount: 0 }).success).toBe(true);
    expect(appGetInfoResult.safeParse({ version: "1.0.0" }).success).toBe(false);
  });
});
