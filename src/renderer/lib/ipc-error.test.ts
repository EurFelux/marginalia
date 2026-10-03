import { describe, expect, it } from "vitest";
import { ipcErrorMessage } from "@renderer/lib/ipc-error";

describe("ipcErrorMessage", () => {
  it("strips Electron's remote-method prefix", () => {
    expect(
      ipcErrorMessage(
        new Error(
          "Error invoking remote method 'bash:open-workdir': Error: The working directory is missing",
        ),
      ),
    ).toBe("The working directory is missing");
    expect(ipcErrorMessage(new Error("Error invoking remote method 'x': TypeError: bad"))).toBe(
      "bad",
    );
  });

  it("leaves other messages alone", () => {
    expect(ipcErrorMessage(new Error("plain"))).toBe("plain");
    expect(ipcErrorMessage("text")).toBe("text");
  });
});
