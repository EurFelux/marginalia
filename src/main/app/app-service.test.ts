import { describe, expect, it, vi } from "vitest";
import { appService, initAppService, type AppServiceEnv } from "./app-service";

function makeEnv(overrides: Partial<AppServiceEnv> = {}): AppServiceEnv {
  return {
    dataDir: "/tmp/app-service-test",
    isDev: false,
    openFolder: async () => {},
    ...overrides,
  };
}

describe("app-service", () => {
  it("throws on env access before initialization (fail-fast)", async () => {
    // 顶部静态 import 的单例可能已被全局 setup 注入（后续 Task 4 之后）；
    // 用 resetModules + 动态 import 构造全新未注入实例来测 fail-fast。
    vi.resetModules();
    const fresh = await import("./app-service");
    expect(() => fresh.appService.env).toThrow(/not initialized/);
  });

  it("returns the injected env after initialization", () => {
    const env = makeEnv();
    initAppService(env);
    expect(appService.env).toBe(env);
  });

  it("last injection wins on repeated init", () => {
    initAppService(makeEnv({ dataDir: "/tmp/first" }));
    initAppService(makeEnv({ dataDir: "/tmp/second" }));
    expect(appService.env.dataDir).toBe("/tmp/second");
  });

  it("invokes the injected openFolder capability with the given dir", async () => {
    const openFolder = vi.fn(async () => {});
    initAppService(makeEnv({ openFolder }));
    await appService.env.openFolder("/some/dir");
    expect(openFolder).toHaveBeenCalledWith("/some/dir");
  });
});
