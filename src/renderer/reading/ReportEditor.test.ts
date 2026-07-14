/* @vitest-environment happy-dom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ReportEditor } from "@renderer/reading/ReportEditor";

let submit: ((content: string) => void) | undefined;

vi.mock("@renderer/components/MarkdownEditor", () => ({
  MarkdownEditor: ({ onSubmit }: { onSubmit?: (content: string) => void }) => {
    submit = onSubmit;
    return null;
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  submit = undefined;
});

describe("ReportEditor", () => {
  it.each([
    ["whitespace-only content", false, "  \n\t ", []],
    ["valid content", false, "  # Report  ", ["# Report"]],
    ["disabled editor", true, "# Report", []],
  ] as const)(
    "does not bypass save guards for Cmd/Ctrl+Enter with %s",
    (_name, disabled, content, expected) => {
      const onSave = vi.fn();
      act(() =>
        root.render(
          createElement(ReportEditor, {
            initialContent: "",
            disabled,
            onSave,
            onCancel: vi.fn(),
          }),
        ),
      );

      act(() => submit?.(content));

      expect(onSave.mock.calls).toEqual(expected.map((value) => [value]));
    },
  );
});
