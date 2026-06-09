import { describe, expect, it } from "vitest";
import { C } from "@shared/ipc";
import { appBindings } from "@main/ipc/app-handlers";
import { libraryBindings } from "@main/ipc/library-handlers";
import { settingsBindings } from "@main/ipc/settings-handlers";
import { chatBindings } from "@main/ipc/chat-handlers";
import { annotationsBindings } from "@main/ipc/annotations-handlers";
import { preferencesBindings } from "@main/ipc/preferences-handlers";
import { aiBindings } from "@main/ipc/ai-handlers";
import { logBindings } from "@main/ipc/log-handlers";
import { statsBindings } from "@main/ipc/stats-handlers";
import { backupBindings } from "@main/ipc/backup-handlers";

const allBindings = [
  ...appBindings,
  ...libraryBindings,
  ...settingsBindings,
  ...chatBindings,
  ...annotationsBindings,
  ...preferencesBindings,
  ...aiBindings,
  ...logBindings,
  ...statsBindings,
  ...backupBindings,
];

describe("ipc bindings coverage", () => {
  const boundChannels = new Set(allBindings.map((b) => b.contract.channel));
  const invokeChannels = new Set(
    Object.values(C)
      .filter((c) => c.kind === "invoke")
      .map((c) => c.channel),
  );

  it("every invoke contract has exactly one binding (no missing, no extra, no dup)", () => {
    expect(allBindings.length).toBe(boundChannels.size); // 无重复 channel
    expect(boundChannels).toEqual(invokeChannels); // 双向相等：覆盖全部 invoke，且无 invoke 之外的 binding
  });
});
