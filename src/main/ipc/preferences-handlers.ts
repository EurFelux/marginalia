import { z } from "zod";
import { IPC } from "@shared/ipc";
import {
  setPreferenceInput,
  type PreferencesSnapshot,
  type SetPreferenceInput,
} from "@shared/preferences";
import { getDb } from "@main/db/instance";
import { getAllPreferences, setPreference } from "@main/preferences/repository";
import { handle } from "@main/ipc/registry";

export function registerPreferenceHandlers(): void {
  handle<void, PreferencesSnapshot>(IPC.preferencesGetAll, z.void(), () =>
    getAllPreferences(getDb()),
  );

  handle<SetPreferenceInput, void>(IPC.preferencesSet, setPreferenceInput, (input) => {
    // 按 key 判别窄化，使 (key, value) 关联类型传给泛型 setPreference 时成立（input 已经 Zod 校验）。
    switch (input.key) {
      case "readerPrefs":
        return setPreference(getDb(), input.key, input.value);
      case "lastHighlightStyle":
        return setPreference(getDb(), input.key, input.value);
      case "autoSummarize":
        return setPreference(getDb(), input.key, input.value);
    }
  });
}
