import { mkdtempSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkdir } from "@main/shell/workdir";

const root = mkdtempSync(path.join(tmpdir(), "workdir-"));

describe("resolveWorkdir", () => {
  it("creates the default workspace on first use", async () => {
    const dir = path.join(root, "nested", "workspace");
    await expect(resolveWorkdir(null, dir)).resolves.toBe(dir);
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it("uses an existing custom folder as-is", async () => {
    await expect(resolveWorkdir(root, "/unused")).resolves.toBe(root);
  });

  it("refuses a missing or non-folder custom path without creating it", async () => {
    const missing = path.join(root, "missing");
    await expect(resolveWorkdir(missing, "/unused")).rejects.toThrow(/Settings › Commands/);
    await expect(stat(missing)).rejects.toThrow();
    const file = path.join(root, "file.txt");
    writeFileSync(file, "x");
    await expect(resolveWorkdir(file, "/unused")).rejects.toThrow(/not a folder/);
  });
});
