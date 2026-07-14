/* @vitest-environment happy-dom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BackupExportButton } from "@renderer/settings/BackupExportButton";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

if (!globalThis.PointerEvent) {
  Object.defineProperty(globalThis, "PointerEvent", { value: MouseEvent });
}

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

describe("BackupExportButton", () => {
  it("uses compact for the main action", () => {
    const onExport = vi.fn();
    act(() => root.render(createElement(BackupExportButton, { disabled: false, onExport })));
    const main = host.querySelector<HTMLButtonElement>('[data-slot="backup-export-compact"]')!;
    act(() => main.click());
    expect(onExport).toHaveBeenCalledWith("compact");
  });

  it("uses full for the dropdown item", async () => {
    const onExport = vi.fn();
    act(() => root.render(createElement(BackupExportButton, { disabled: false, onExport })));
    const trigger = host.querySelector<HTMLButtonElement>('[data-slot="backup-export-menu"]')!;
    await act(async () => trigger.click());
    const full = document.body.querySelector<HTMLElement>('[data-slot="backup-export-full"]')!;
    await act(async () => full.click());
    expect(onExport).toHaveBeenCalledWith("full");
  });
});
