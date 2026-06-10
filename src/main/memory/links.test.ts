import { describe, expect, it } from "vitest";
import { extractLinks } from "@main/memory/links";

describe("extractLinks", () => {
  it("extracts [[slug]] occurrences in order, deduped", () => {
    expect(extractLinks("see [[a-b]] and [[c]] and [[a-b]] again")).toEqual(["a-b", "c"]);
  });
  it("ignores malformed brackets and illegal slugs", () => {
    expect(extractLinks("[[]] [[ x ]] [[UPPER]] [[has_underscore]] [single] [[ok-1]]")).toEqual([
      "ok-1",
    ]);
  });
  it("returns empty for body without links", () => {
    expect(extractLinks("plain text")).toEqual([]);
  });
});
