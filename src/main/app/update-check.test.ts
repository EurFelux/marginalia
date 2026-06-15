import { describe, expect, it, vi } from "vitest";
import { checkForUpdate } from "./update-check";

const REPO = { owner: "EurFelux", name: "marginalia" };

/** 造一个返回给定 releases 数组的假 fetch；记录最后一次请求的 init 以便断言请求头。 */
function fetchReturning(releases: unknown, init?: { ok?: boolean; status?: number }) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const impl = vi.fn(async (url: string, reqInit?: RequestInit) => {
    calls.push({ url, init: reqInit });
    return {
      ok: init?.ok ?? true,
      status: init?.status ?? 200,
      statusText: "OK",
      json: async () => releases,
    } as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

describe("checkForUpdate", () => {
  it("reports update-available when latest tag is greater", async () => {
    const { impl } = fetchReturning([
      { tag_name: "v0.14.0", html_url: "https://x/releases/v0.14.0" },
    ]);
    const res = await checkForUpdate("0.13.0", impl, REPO);
    expect(res).toEqual({
      status: "update-available",
      currentVersion: "0.13.0",
      latestVersion: "0.14.0",
      releaseUrl: "https://x/releases/v0.14.0",
    });
  });

  it("treats prerelease tags via semver semantics", async () => {
    const { impl } = fetchReturning([{ tag_name: "v0.14.0-beta.1", html_url: "https://x/r" }]);
    const res = await checkForUpdate("0.13.0", impl, REPO);
    expect(res.status).toBe("update-available");
    if (res.status === "update-available") expect(res.latestVersion).toBe("0.14.0-beta.1");
  });

  it("prompts update when current is a prerelease and a stable release exists", async () => {
    const { impl } = fetchReturning([{ tag_name: "v0.14.0", html_url: "https://x/r" }]);
    const res = await checkForUpdate("0.14.0-beta.1", impl, REPO);
    expect(res.status).toBe("update-available");
    if (res.status === "update-available") expect(res.latestVersion).toBe("0.14.0");
  });

  it("reports up-to-date when latest equals current", async () => {
    const { impl } = fetchReturning([{ tag_name: "v0.13.0", html_url: "https://x/r" }]);
    const res = await checkForUpdate("0.13.0", impl, REPO);
    expect(res).toEqual({
      status: "up-to-date",
      currentVersion: "0.13.0",
      latestVersion: "0.13.0",
    });
  });

  it("reports up-to-date when latest is lower (no downgrade prompt)", async () => {
    const { impl } = fetchReturning([{ tag_name: "v0.12.0", html_url: "https://x/r" }]);
    const res = await checkForUpdate("0.13.0", impl, REPO);
    expect(res).toEqual({
      status: "up-to-date",
      currentVersion: "0.13.0",
      latestVersion: "0.12.0",
    });
  });

  it("reports up-to-date on empty releases array", async () => {
    const { impl } = fetchReturning([]);
    const res = await checkForUpdate("0.13.0", impl, REPO);
    expect(res).toEqual({
      status: "up-to-date",
      currentVersion: "0.13.0",
      latestVersion: "0.13.0",
    });
  });

  it("reports error on non-200 response", async () => {
    const { impl } = fetchReturning([], { ok: false, status: 403 });
    const res = await checkForUpdate("0.13.0", impl, REPO);
    expect(res.status).toBe("error");
  });

  it("reports error when fetch rejects", async () => {
    const impl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await checkForUpdate("0.13.0", impl, REPO);
    expect(res).toEqual({ status: "error", currentVersion: "0.13.0", message: "network down" });
  });

  it("reports error on unparseable tag", async () => {
    const { impl } = fetchReturning([{ tag_name: "nightly", html_url: "https://x/r" }]);
    const res = await checkForUpdate("0.13.0", impl, REPO);
    expect(res.status).toBe("error");
  });

  it("sends required User-Agent header (GitHub 403s without it)", async () => {
    const { impl, calls } = fetchReturning([{ tag_name: "v0.13.0", html_url: "https://x/r" }]);
    await checkForUpdate("0.13.0", impl, REPO);
    const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers["User-Agent"]).toBeTruthy();
  });
});
