import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validateInput } from "@main/ipc/validate";

const schema = z.object({ msg: z.string().min(1) });

describe("validateInput", () => {
  it("returns parsed data on valid input", () => {
    expect(validateInput("ping", schema, { msg: "hi" })).toEqual({ msg: "hi" });
  });

  it("throws a channel-tagged 'invalid input' error on invalid input", () => {
    expect(() => validateInput("ping", schema, { msg: 123 })).toThrow(/IPC ping invalid input/);
  });

  it("rejects null and undefined raw input", () => {
    expect(() => validateInput("ping", schema, undefined)).toThrow(/invalid input/);
    expect(() => validateInput("ping", schema, null)).toThrow(/invalid input/);
  });
});
