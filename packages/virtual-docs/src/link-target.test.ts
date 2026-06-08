import { describe, expect, it } from "vitest";
import { classifyLink } from "./link-target";

describe("classifyLink", () => {
  it("absolute http/https/mailto ⇒ external", () => {
    expect(classifyLink("https://x.com")).toEqual({ type: "external", url: "https://x.com" });
    expect(classifyLink("mailto:a@b.com")).toEqual({ type: "external", url: "mailto:a@b.com" });
  });
  it("relative path / fragment ⇒ internal (raw href)", () => {
    expect(classifyLink("text00000.html#filepos123")).toEqual({
      type: "internal",
      href: "text00000.html#filepos123",
    });
    expect(classifyLink("#filepos123")).toEqual({ type: "internal", href: "#filepos123" });
    expect(classifyLink("../ch2.xhtml")).toEqual({ type: "internal", href: "../ch2.xhtml" });
  });
  it("empty / null-ish ⇒ null (ignore)", () => {
    expect(classifyLink("")).toBeNull();
    expect(classifyLink("#")).toBeNull();
  });
});
