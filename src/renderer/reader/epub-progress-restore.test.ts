import { describe, expect, it } from "vitest";
import { advanceRestoreGate } from "./epub-progress-restore";

describe("advanceRestoreGate", () => {
  it("suppresses persistence while an intermediate section is visible", () => {
    expect(advanceRestoreGate(8, 6)).toEqual({ target: 8, shouldPersist: false });
  });

  it("keeps persistence closed during transient target visibility", () => {
    expect(advanceRestoreGate(8, 8)).toEqual({ target: 8, shouldPersist: false });
  });

  it("keeps normal reading persistence open", () => {
    expect(advanceRestoreGate(null, 3)).toEqual({ target: null, shouldPersist: true });
  });
});
