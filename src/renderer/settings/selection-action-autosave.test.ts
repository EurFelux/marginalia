import { describe, expect, it } from "vitest";
import {
  planAutosave,
  validateFields,
  type EditorFields,
} from "@renderer/settings/selection-action-autosave";
import {
  SELECTION_ACTION_LABEL_MAX,
  SELECTION_ACTION_PROMPT_MAX,
  type SelectionActionDto,
} from "@shared/selection-actions";

const fields = (over: Partial<EditorFields> = {}): EditorFields => ({
  label: "Rebut",
  icon: "swords",
  prompt: "Find rebuttals.",
  autoSend: false,
  ...over,
});

const custom: SelectionActionDto = {
  kind: "custom",
  id: "c1",
  label: "Rebut",
  icon: "swords",
  prompt: "Find rebuttals.",
  enabled: true,
  autoSend: false,
};

const explain: SelectionActionDto = {
  kind: "builtin",
  id: "explain",
  prompt: null,
  enabled: true,
  autoSend: false,
};

const DEFAULT = "Please explain the selected content.";

describe("validateFields", () => {
  it("requires label and prompt for custom actions", () => {
    expect(validateFields("custom", fields({ label: " ", prompt: "" }))).toEqual([
      "labelEmpty",
      "promptEmpty",
    ]);
  });

  it("allows an empty built-in prompt (= default)", () => {
    expect(validateFields("builtin", fields({ label: "", prompt: "" }))).toEqual([]);
  });

  it("flags over-long values", () => {
    expect(
      validateFields(
        "custom",
        fields({
          label: "x".repeat(SELECTION_ACTION_LABEL_MAX + 1),
          prompt: "x".repeat(SELECTION_ACTION_PROMPT_MAX + 1),
        }),
      ),
    ).toEqual(["labelTooLong", "promptTooLong"]);
  });
});

describe("planAutosave: drafts", () => {
  const draft = { kind: "draft" as const, creating: false };

  it("does not create until label and prompt are both valid", () => {
    expect(planAutosave(draft, fields({ prompt: "" }), "")).toBeNull();
    expect(planAutosave(draft, fields({ label: "" }), "")).toBeNull();
  });

  it("creates with trimmed values once valid", () => {
    expect(planAutosave(draft, fields({ label: " Rebut ", prompt: " p " }), "")).toEqual({
      kind: "create",
      input: { label: "Rebut", icon: "swords", prompt: "p", autoSend: false },
    });
  });

  it("waits while the create request is in flight", () => {
    expect(planAutosave({ kind: "draft", creating: true }, fields(), "")).toBeNull();
  });
});

describe("planAutosave: saved custom actions", () => {
  const saved = { kind: "saved" as const, dto: custom };

  it("sends nothing when nothing changed", () => {
    expect(planAutosave(saved, fields({ label: " Rebut " }), "")).toBeNull();
  });

  it("sends only the changed fields", () => {
    expect(planAutosave(saved, fields({ icon: "brain", autoSend: true }), "")).toEqual({
      kind: "update",
      input: { kind: "custom", id: "c1", patch: { icon: "brain", autoSend: true } },
    });
  });

  it("holds back an invalid field but still saves the valid ones", () => {
    expect(planAutosave(saved, fields({ label: "", autoSend: true }), "")).toEqual({
      kind: "update",
      input: { kind: "custom", id: "c1", patch: { autoSend: true } },
    });
    expect(planAutosave(saved, fields({ prompt: "  " }), "")).toBeNull();
  });
});

describe("planAutosave: built-in actions", () => {
  const saved = { kind: "saved" as const, dto: explain };

  it("stores a written prompt", () => {
    expect(planAutosave(saved, fields({ prompt: "Explain like I'm five." }), DEFAULT)).toEqual({
      kind: "update",
      input: { kind: "builtin", id: "explain", patch: { prompt: "Explain like I'm five." } },
    });
  });

  it("treats blank or default text as the default (null)", () => {
    expect(planAutosave(saved, fields({ prompt: "" }), DEFAULT)).toBeNull();
    expect(planAutosave(saved, fields({ prompt: ` ${DEFAULT} ` }), DEFAULT)).toBeNull();
    const written = { kind: "saved" as const, dto: { ...explain, prompt: "Custom." } };
    expect(planAutosave(written, fields({ prompt: "" }), DEFAULT)).toEqual({
      kind: "update",
      input: { kind: "builtin", id: "explain", patch: { prompt: null } },
    });
  });

  it("ignores label and icon for built-ins", () => {
    expect(
      planAutosave(saved, fields({ label: "X", icon: "brain", prompt: "" }), DEFAULT),
    ).toBeNull();
  });
});
