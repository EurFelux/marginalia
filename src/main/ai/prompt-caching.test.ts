import { describe, expect, it } from "vitest";
import type { ModelMessage } from "ai";
import { breakpointStrategy, withPromptCaching } from "@main/ai/prompt-caching";

const po = (m: ModelMessage) => (m as { providerOptions?: unknown }).providerOptions;
const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral" } } };

describe("breakpointStrategy (provider-agnostic placement)", () => {
  const MARK = { demo: { mark: true } };
  const strategy = breakpointStrategy(MARK);

  it("tags system with the given marker (placement is independent of marker contents)", () => {
    const out = strategy({ system: "SYS", messages: [{ role: "user", content: "q1" }] });
    expect(out.system).toEqual({ role: "system", content: "SYS", providerOptions: MARK });
  });

  it("marks only the last two user turns", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "q1" }, // older — not marked
      { role: "assistant", content: "a1" }, // assistant — never marked
      { role: "user", content: "q2" }, // marked
      { role: "assistant", content: "a2" },
      { role: "user", content: "q3" }, // marked (current)
    ];
    const out = strategy({ system: "SYS", messages });
    expect(po(out.messages[0])).toBeUndefined();
    expect(po(out.messages[1])).toBeUndefined();
    expect(po(out.messages[2])).toEqual(MARK);
    expect(po(out.messages[3])).toBeUndefined();
    expect(po(out.messages[4])).toEqual(MARK);
  });

  it("a single user turn gets one breakpoint", () => {
    const out = strategy({ system: "SYS", messages: [{ role: "user", content: "only" }] });
    expect(po(out.messages[0])).toEqual(MARK);
  });

  it("undefined system stays undefined; rolling breakpoints still apply", () => {
    const out = strategy({ system: undefined, messages: [{ role: "user", content: "q1" }] });
    expect(out.system).toBeUndefined();
    expect(po(out.messages[0])).toEqual(MARK);
  });

  it("does not mutate the caller's messages array", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "q1" }];
    strategy({ system: "SYS", messages });
    expect(messages[0]).toEqual({ role: "user", content: "q1" });
  });
});

describe("withPromptCaching (per-provider dispatch)", () => {
  it("anthropic: applies ephemeral cache breakpoints (system + last user turn)", () => {
    const out = withPromptCaching({
      providerType: "anthropic",
      system: "SYS",
      messages: [{ role: "user", content: "q1" }],
    });
    expect(out.system).toEqual({ role: "system", content: "SYS", providerOptions: EPHEMERAL });
    expect(po(out.messages[0])).toEqual(EPHEMERAL);
  });

  it.each(["openai-responses", "openai-chat-completions", "google-generate-content"] as const)(
    "%s: implicit caching — passes through untouched",
    (providerType) => {
      const messages: ModelMessage[] = [{ role: "user", content: "q1" }];
      const out = withPromptCaching({ providerType, system: "SYS", messages });
      expect(out.system).toBe("SYS");
      expect(out.messages).toBe(messages);
      expect(po(out.messages[0])).toBeUndefined();
    },
  );

  it("undefined provider: passes through untouched", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "q1" }];
    const out = withPromptCaching({ providerType: undefined, system: "SYS", messages });
    expect(out.messages).toBe(messages);
  });
});
