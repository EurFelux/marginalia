import { splitForUtterance } from "./split-for-utterance";

export type TtsState = "idle" | "playing" | "paused";

/** SpeechSynthesisUtterance 的可 mock 收窄面。 */
export interface UtteranceLike {
  text: string;
  voice: SpeechSynthesisVoice | null;
  rate: number;
  onend: (() => void) | null;
  onerror: ((err?: unknown) => void) | null;
}

/** speechSynthesis 的可 mock 收窄面（真实现见 voices.ts 的 browserSpeechPort）。 */
export interface SpeechPort {
  createUtterance: (text: string) => UtteranceLike;
  speak: (u: UtteranceLike) => void;
  cancel: () => void;
  pause: () => void;
  resume: () => void;
}

export interface TtsEngineEvents {
  /** 段开始朗读（驱动高亮与滚动）。 */
  onParagraphChange: (index: number) => void;
  onStateChange: (state: TtsState) => void;
  /** 队列读尽（spec 的 onChapterEnd——引擎不懂章节，集成层接「下一章」）。 */
  onQueueEnd: () => void;
  /** 单 utterance 失败（已跳过继续）；日志归集成层。 */
  onUtteranceError: (text: string, err: unknown) => void;
}

export interface PlayOptions {
  rate: number;
  /** 每个 utterance 文本 → voice（detect+pick 组合由集成层注入，引擎保持纯排队逻辑）。 */
  pickVoiceFor: (text: string) => SpeechSynthesisVoice | null;
}

/**
 * 段队列状态机（spec §4.3）：idle → playing ⇄ paused → idle。
 * generation 计数器使 cancel 后迟到的 onend/onerror 失效（部分平台 cancel
 * 会对挂起 utterance 触发 onend，不防会幽灵推进）。
 */
export function createTtsEngine(port: SpeechPort, events: TtsEngineEvents) {
  let state: TtsState = "idle";
  let gen = 0;
  let texts: string[] = [];
  let current = 0;
  let opts: PlayOptions = { rate: 1, pickVoiceFor: () => null };

  const setState = (s: TtsState) => {
    if (s === state) return;
    state = s;
    events.onStateChange(s);
  };

  /** spec §8 防御：pause 后直接 cancel 在部分平台不干净，统一先 resume。 */
  const hardCancel = () => {
    port.resume();
    port.cancel();
  };

  const speakChunks = (chunks: string[], ci: number, myGen: number) => {
    if (myGen !== gen) return;
    if (ci >= chunks.length) {
      playParagraph(current + 1, myGen);
      return;
    }
    const text = chunks[ci]!;
    const u = port.createUtterance(text);
    u.voice = opts.pickVoiceFor(text);
    u.rate = opts.rate;
    u.onend = () => speakChunks(chunks, ci + 1, myGen);
    u.onerror = (err) => {
      if (myGen !== gen) return;
      events.onUtteranceError(text, err);
      speakChunks(chunks, ci + 1, myGen);
    };
    port.speak(u);
  };

  const playParagraph = (i: number, myGen: number) => {
    if (myGen !== gen) return;
    if (i >= texts.length) {
      setState("idle");
      events.onQueueEnd();
      return;
    }
    current = i;
    events.onParagraphChange(i);
    speakChunks(splitForUtterance(texts[i]!), 0, myGen);
  };

  return {
    play(newTexts: string[], startIndex: number, o: PlayOptions) {
      gen++;
      hardCancel();
      texts = newTexts;
      opts = o;
      setState("playing");
      playParagraph(startIndex, gen);
    },
    pause() {
      if (state !== "playing") return;
      port.pause();
      setState("paused");
    },
    resume() {
      if (state !== "paused") return;
      port.resume();
      setState("playing");
    },
    stop() {
      if (state === "idle") return;
      gen++;
      hardCancel();
      setState("idle");
    },
    setRate(rate: number) {
      opts = { ...opts, rate };
      if (state === "idle") return;
      // 从当前段头以新 rate 重读（spec §4.3）
      gen++;
      hardCancel();
      setState("playing");
      playParagraph(current, gen);
    },
    state: () => state,
    currentIndex: () => current,
  };
}

export type TtsEngine = ReturnType<typeof createTtsEngine>;
