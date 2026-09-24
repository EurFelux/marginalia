// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { elementOf } from "./element-of";

describe("elementOf", () => {
  const doc = new DOMParser().parseFromString("<p id='p'>text</p>", "text/html");
  const p = doc.getElementById("p")!;

  it("returns the parent element of a text node", () => {
    expect(elementOf(p.firstChild)).toBe(p);
  });

  it("returns an element as itself", () => {
    expect(elementOf(p)).toBe(p);
  });

  it("returns null for no node", () => {
    expect(elementOf(null)).toBeNull();
  });
});
