import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { appService, initAppService, type AppServiceEnv } from "./app-service";
import * as barrel from "./index";

function makeEnv(overrides: Partial<AppServiceEnv> = {}): AppServiceEnv {
  return {
    dataDir: "/tmp/app-service-test",
    isDev: false,
    openFolder: async () => {},
    ...overrides,
  };
}

describe("app-service", () => {
  it("throws on any member access before initialization (fail-fast)", async () => {
    // 顶部静态 import 的单例已被全局 setup 注入；
    // 用 resetModules + 动态 import 构造全新未注入实例来测 fail-fast。
    vi.resetModules();
    const fresh = await import("./app-service");
    expect(() => fresh.appService.getPath("logsDir")).toThrow(/not initialized/);
    expect(() => fresh.appService.isDev).toThrow(/not initialized/);
    // openFolder 委托前同步检查注入，因此同步 throw（而非 rejected promise）
    expect(() => fresh.appService.openFolder("/x")).toThrow(/not initialized/);
  });

  it("getPath maps *Dir keys to module directories under dataDir", () => {
    initAppService(makeEnv({ dataDir: "/tmp/root" }));
    expect(appService.getPath("logsDir")).toBe(path.join("/tmp/root", "logs"));
    expect(appService.getPath("booksDir")).toBe(path.join("/tmp/root", "books"));
  });

  it("getPath maps *File keys to full file paths (db at historical root location)", () => {
    initAppService(makeEnv({ dataDir: "/tmp/root" }));
    expect(appService.getPath("dbFile")).toBe(path.join("/tmp/root", "marginalia.db"));
  });

  it("exposes isDev from the injected env", () => {
    initAppService(makeEnv({ isDev: true }));
    expect(appService.isDev).toBe(true);
  });

  it("last injection wins on repeated init", () => {
    initAppService(makeEnv({ dataDir: "/tmp/first" }));
    initAppService(makeEnv({ dataDir: "/tmp/second" }));
    expect(appService.getPath("logsDir")).toBe(path.join("/tmp/second", "logs"));
  });

  it("invokes the injected openFolder capability with the given dir", async () => {
    const openFolder = vi.fn(async () => {});
    initAppService(makeEnv({ openFolder }));
    await appService.openFolder("/some/dir");
    expect(openFolder).toHaveBeenCalledWith("/some/dir");
  });

  it("does not expose the raw dataDir on the public surface", () => {
    initAppService(makeEnv());
    expect("env" in appService).toBe(false);
    expect("dataDir" in appService).toBe(false);
  });
});

describe("app barrel", () => {
  it("exposes only appService (encapsulation does not leak)", () => {
    expect(Object.keys(barrel).sort()).toEqual(["appService"]);
  });
});
