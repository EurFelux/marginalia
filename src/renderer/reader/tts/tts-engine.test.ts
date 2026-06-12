import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTtsEngine, type SpeechPort, type UtteranceLike } from "./tts-engine";

function mockPort() {
  const spoken: UtteranceLike[] = [];
  const cancel = vi.fn();
  const pause = vi.fn();
  const resume = vi.fn();
  const port: SpeechPort = {
    createUtterance: (text) => ({ text, voice: null, rate: 1, onend: null, onerror: null }),
    speak: (u) => void spoken.push(u),
    cancel,
    pause,
    resume,
  };
  return { port, spoken, last: () => spoken[spoken.length - 1]! };
}

function makeEvents() {
  return {
    onParagraphChange: vi.fn(),
    onStateChange: vi.fn(),
    onQueueEnd: vi.fn(),
    onUtteranceError: vi.fn(),
  };
}

const OPTS = { rate: 1.25, pickVoiceFor: () => null };

describe("tts-engine", () => {
  let m: ReturnType<typeof mockPort>;
  let ev: ReturnType<typeof makeEvents>;
  beforeEach(() => {
    m = mockPort();
    ev = makeEvents();
  });

  it("plays paragraphs sequentially via onend", () => {
    const e = createTtsEngine(m.port, ev);
    e.play(["One.", "Two."], 0, OPTS);
    expect(e.state()).toBe("playing");
    expect(ev.onParagraphChange).toHaveBeenLastCalledWith(0);
    expect(m.last().text).toBe("One.");
    expect(m.last().rate).toBe(1.25);
    m.last().onend?.();
    expect(ev.onParagraphChange).toHaveBeenLastCalledWith(1);
    expect(m.last().text).toBe("Two.");
    m.last().onend?.();
    expect(ev.onQueueEnd).toHaveBeenCalledOnce();
    expect(e.state()).toBe("idle");
  });

  it("splits an overlong paragraph into chunks but reports one paragraph index", () => {
    const e = createTtsEngine(m.port, ev);
    const long = "字".repeat(200) + "。" + "句".repeat(200) + "。";
    e.play([long], 0, OPTS);
    m.last().onend?.();
    expect(m.spoken.length).toBe(2); // 两个 chunk
    expect(ev.onParagraphChange).toHaveBeenCalledTimes(1); // 段索引只发一次
    m.last().onend?.();
    expect(ev.onQueueEnd).toHaveBeenCalledOnce();
  });

  it("onerror skips to next utterance and reports", () => {
    const e = createTtsEngine(m.port, ev);
    e.play(["Bad.", "Good."], 0, OPTS);
    m.last().onerror?.(new Error("boom"));
    expect(ev.onUtteranceError).toHaveBeenCalledOnce();
    expect(m.last().text).toBe("Good.");
    void e;
  });

  it("stop cancels (resume-then-cancel) and ignores stale onend", () => {
    const e = createTtsEngine(m.port, ev);
    e.play(["One.", "Two."], 0, OPTS);
    const u = m.last();
    e.stop();
    expect(m.port.resume).toHaveBeenCalled(); // spec §8：先 resume 再 cancel
    expect(m.port.cancel).toHaveBeenCalled();
    expect(e.state()).toBe("idle");
    u.onend?.(); // cancel 在部分平台触发挂起 utterance 的 onend——不得推进
    expect(m.spoken.length).toBe(1);
  });

  it("pause/resume toggles state without re-speaking", () => {
    const e = createTtsEngine(m.port, ev);
    e.play(["One."], 0, OPTS);
    e.pause();
    expect(e.state()).toBe("paused");
    e.resume();
    expect(e.state()).toBe("playing");
    expect(m.spoken.length).toBe(1);
  });

  it("setRate while playing restarts current paragraph at new rate", () => {
    const e = createTtsEngine(m.port, ev);
    e.play(["One.", "Two."], 0, OPTS);
    m.last().onend?.(); // 进入段 1
    e.setRate(2);
    expect(m.last().text).toBe("Two."); // 从当前段头重读
    expect(m.last().rate).toBe(2);
  });

  it("play starting mid-queue honors startIndex", () => {
    const e = createTtsEngine(m.port, ev);
    e.play(["A.", "B.", "C."], 1, OPTS);
    expect(m.last().text).toBe("B.");
  });

  it("setRate while paused stays paused", () => {
    const e = createTtsEngine(m.port, ev);
    e.play(["One.", "Two."], 0, OPTS);
    e.pause();
    e.setRate(2);
    expect(e.state()).toBe("paused");
    expect(m.spoken.length).toBe(1); // 未重新 speak
  });

  it("resume after paused setRate restarts current paragraph at new rate", () => {
    const e = createTtsEngine(m.port, ev);
    e.play(["One.", "Two."], 0, OPTS);
    m.last().onend?.(); // 进入段 1
    e.pause();
    e.setRate(2);
    e.resume();
    expect(e.state()).toBe("playing");
    expect(m.last().text).toBe("Two."); // 从当前段头重读
    expect(m.last().rate).toBe(2);
  });

  it("fires onQueueEnd before publishing idle", () => {
    const order: string[] = [];
    const events = {
      onParagraphChange: vi.fn(),
      onStateChange: (s: string) => void order.push(`state:${s}`),
      onQueueEnd: () => void order.push("queueEnd"),
      onUtteranceError: vi.fn(),
    };
    const e = createTtsEngine(m.port, events);
    e.play(["One."], 0, OPTS);
    m.last().onend?.();
    expect(order).toEqual(["state:playing", "queueEnd", "state:idle"]);
  });

  it("suppresses idle when onQueueEnd synchronously restarts playback", () => {
    const states: string[] = [];
    let engine!: ReturnType<typeof createTtsEngine>;
    const events = {
      onParagraphChange: vi.fn(),
      onStateChange: (s: string) => void states.push(s),
      onQueueEnd: () => engine.play(["Next."], 0, OPTS),
      onUtteranceError: vi.fn(),
    };
    engine = createTtsEngine(m.port, events);
    engine.play(["One."], 0, OPTS);
    m.last().onend?.();
    expect(states).not.toContain("idle");
    expect(engine.state()).toBe("playing");
    expect(m.last().text).toBe("Next.");
  });
});
