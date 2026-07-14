/* @vitest-environment happy-dom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MarkdownEditor } from "@renderer/components/MarkdownEditor";

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
});

describe("MarkdownEditor", () => {
  it("submits the current document when Ctrl+Enter is pressed", () => {
    const onSubmit = vi.fn();
    act(() => root.render(createElement(MarkdownEditor, { defaultValue: "# Report", onSubmit })));

    const editor = host.querySelector<HTMLElement>(".cm-content");
    expect(editor).not.toBeNull();

    act(() => {
      editor?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "Enter" }),
      );
    });

    expect(onSubmit).toHaveBeenCalledWith("# Report");
  });
});
