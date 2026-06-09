import { describe, expect, it } from "vitest";
import { checkRestoreCompatibility } from "@main/backup/compat";

const known = ["0001_a", "0002_b", "0003_c"];

describe("checkRestoreCompatibility", () => {
  it("compatible when bundle head equals current head", () => {
    expect(checkRestoreCompatibility("0003_c", known).compatible).toBe(true);
  });

  it("compatible when bundle is older (head is an earlier known migration)", () => {
    expect(checkRestoreCompatibility("0001_a", known).compatible).toBe(true);
  });

  it("incompatible when bundle head is unknown (newer app)", () => {
    const r = checkRestoreCompatibility("0004_d", known);
    expect(r.compatible).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it("incompatible when bundle head is empty", () => {
    expect(checkRestoreCompatibility("", known).compatible).toBe(false);
  });
});
