import { describe, expect, it } from "vitest";
import {
  BUILTIN_SELECTION_ACTION_ICONS,
  SELECTION_ACTION_ICONS,
  SELECTION_ACTION_LABEL_MAX,
  SELECTION_ACTION_PROMPT_MAX,
  createSelectionActionInput,
  normalizeBuiltinPrompt,
  resolveSelectionAction,
  toSelectionActionIcon,
  updateSelectionActionInput,
  type BuiltinSelectionDefaults,
} from "@shared/selection-actions";

const defaults: BuiltinSelectionDefaults = {
  label: (id) => `label:${id}`,
  prompt: (id) => (id === "ask" ? "" : `prompt:${id}`),
};

const valid = { label: "Rebut", icon: "swords", prompt: "Find rebuttals.", autoSend: false };

describe("createSelectionActionInput", () => {
  it("trims label and prompt", () => {
    expect(
      createSelectionActionInput.parse({ ...valid, label: "  Rebut ", prompt: " p " }),
    ).toMatchObject({ label: "Rebut", prompt: "p" });
  });

  it("rejects blank or over-long labels and prompts", () => {
    for (const bad of [
      { label: "   " },
      { label: "x".repeat(SELECTION_ACTION_LABEL_MAX + 1) },
      { prompt: " " },
      { prompt: "x".repeat(SELECTION_ACTION_PROMPT_MAX + 1) },
    ]) {
      expect(createSelectionActionInput.safeParse({ ...valid, ...bad }).success).toBe(false);
    }
    expect(
      createSelectionActionInput.safeParse({
        ...valid,
        label: "x".repeat(SELECTION_ACTION_LABEL_MAX),
      }).success,
    ).toBe(true);
  });

  it("rejects icons outside the curated list", () => {
    expect(createSelectionActionInput.safeParse({ ...valid, icon: "rocket" }).success).toBe(false);
  });
});

describe("updateSelectionActionInput", () => {
  it("accepts a null built-in prompt (use the default) but not an empty string", () => {
    const ok = { kind: "builtin", id: "ask", patch: { prompt: null } };
    expect(updateSelectionActionInput.safeParse(ok).success).toBe(true);
    const empty = { kind: "builtin", id: "ask", patch: { prompt: "" } };
    expect(updateSelectionActionInput.safeParse(empty).success).toBe(false);
  });

  it("does not let built-ins change their label or icon", () => {
    for (const patch of [{ label: "X" }, { icon: "brain" }]) {
      expect(
        updateSelectionActionInput.safeParse({ kind: "builtin", id: "explain", patch }).success,
      ).toBe(false);
    }
  });

  it("does not accept a null prompt for custom actions", () => {
    expect(
      updateSelectionActionInput.safeParse({ kind: "custom", id: "c1", patch: { prompt: null } })
        .success,
    ).toBe(false);
  });

  it("rejects unknown built-in ids", () => {
    expect(
      updateSelectionActionInput.safeParse({ kind: "builtin", id: "define", patch: {} }).success,
    ).toBe(false);
  });
});

describe("resolveSelectionAction", () => {
  it("fills built-in label, icon and default prompt from the injected defaults", () => {
    expect(
      resolveSelectionAction(
        { kind: "builtin", id: "explain", prompt: null, enabled: true, autoSend: false },
        defaults,
      ),
    ).toEqual({
      id: "explain",
      kind: "builtin",
      label: "label:explain",
      icon: BUILTIN_SELECTION_ACTION_ICONS.explain,
      prompt: "prompt:explain",
      autoSend: false,
      enabled: true,
    });
  });

  it("prefers a written built-in prompt over the default", () => {
    const view = resolveSelectionAction(
      { kind: "builtin", id: "translate", prompt: "Into Japanese.", enabled: true, autoSend: true },
      defaults,
    );
    expect(view).toMatchObject({ prompt: "Into Japanese.", autoSend: true });
  });

  it("turns auto-send off while there is no prompt (Ask without a written prompt)", () => {
    const view = resolveSelectionAction(
      { kind: "builtin", id: "ask", prompt: null, enabled: true, autoSend: true },
      defaults,
    );
    expect(view).toMatchObject({ prompt: "", autoSend: false });
  });

  it("falls back to the default icon for names outside the curated list", () => {
    const view = resolveSelectionAction(
      {
        kind: "custom",
        id: "c1",
        label: "A",
        icon: "rocket",
        prompt: "p",
        enabled: true,
        autoSend: false,
      },
      defaults,
    );
    expect(view.icon).toBe("sparkles");
  });
});

describe("normalizeBuiltinPrompt", () => {
  it("stores null for blank input or the unchanged default", () => {
    expect(normalizeBuiltinPrompt("   ", "Explain it.")).toBeNull();
    expect(normalizeBuiltinPrompt(" Explain it. ", "Explain it.")).toBeNull();
  });

  it("stores the trimmed text otherwise", () => {
    expect(normalizeBuiltinPrompt(" Explain like I'm five. ", "Explain it.")).toBe(
      "Explain like I'm five.",
    );
  });
});

describe("icon list", () => {
  it("has no duplicates and contains every built-in icon", () => {
    expect(new Set(SELECTION_ACTION_ICONS).size).toBe(SELECTION_ACTION_ICONS.length);
    for (const icon of Object.values(BUILTIN_SELECTION_ACTION_ICONS)) {
      expect(toSelectionActionIcon(icon)).toBe(icon);
    }
  });
});
