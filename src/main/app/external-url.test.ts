import { describe, expect, it } from "vitest";
import { isAllowedExternalUrl } from "./external-url";

describe("isAllowedExternalUrl", () => {
  it("allows http/https/mailto", () => {
    expect(isAllowedExternalUrl("https://example.com")).toBe(true);
    expect(isAllowedExternalUrl("http://example.com/x")).toBe(true);
    expect(isAllowedExternalUrl("mailto:a@b.com")).toBe(true);
  });
  it("rejects file/javascript/data and garbage", () => {
    expect(isAllowedExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isAllowedExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isAllowedExternalUrl("data:text/html,<script>")).toBe(false);
    expect(isAllowedExternalUrl("not a url")).toBe(false);
    expect(isAllowedExternalUrl("")).toBe(false);
  });
});
