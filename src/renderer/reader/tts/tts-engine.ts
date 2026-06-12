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
  let rateDirty = false;

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

  const speakChunks = (
    chunks: string[],
    ci: number,
    myGen: number,
    voice: SpeechSynthesisVoice | null,
  ) => {
    if (myGen !== gen) return;
    if (ci >= chunks.length) {
      playParagraph(current + 1, myGen);
      return;
    }
    const text = chunks[ci]!;
    const u = port.createUtterance(text);
    u.voice = voice;
    u.rate = opts.rate;
    u.onend = () => speakChunks(chunks, ci + 1, myGen, voice);
    u.onerror = (err) => {
      if (myGen !== gen) return;
      events.onUtteranceError(text, err);
      speakChunks(chunks, ci + 1, myGen, voice);
    };
    port.speak(u);
  };

  const playParagraph = (i: number, myGen: number) => {
    if (myGen !== gen) return;
    if (i >= texts.length) {
      // 先发 onQueueEnd 再收口 idle：集成层在回调里同步置 crossing/重启播放，
      // 颠倒顺序会让瞬时 idle 泄漏到 UI（跨章控制条闪退）。
      events.onQueueEnd();
      if (myGen === gen) setState("idle"); // 回调内未启动新播放（gen 未变）才收口
      return;
    }
    current = i;
    events.onParagraphChange(i);
    // 同段共享 voice，避免同段多 chunk 因语言检测结果不同而切换声音
    const voice = opts.pickVoiceFor(texts[i]!);
    speakChunks(splitForUtterance(texts[i]!), 0, myGen, voice);
  };

  return {
    play(newTexts: string[], startIndex: number, o: PlayOptions) {
      gen++;
      hardCancel();
      texts = newTexts;
      opts = o;
      rateDirty = false;
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
      if (rateDirty) {
        // 暂停中调速不得擅自开播；新速率在继续时从当前段头生效
        rateDirty = false;
        gen++;
        hardCancel();
        setState("playing");
        playParagraph(current, gen);
      } else {
        port.resume();
        setState("playing");
      }
    },
    stop() {
      if (state === "idle") return;
      gen++;
      hardCancel();
      rateDirty = false;
      setState("idle");
    },
    setRate(rate: number) {
      opts = { ...opts, rate };
      if (state === "idle") return;
      if (state === "paused") {
        // 暂停中调速不得擅自开播；新速率在继续时从当前段头生效
        rateDirty = true;
        return;
      }
      // playing：从当前段头以新 rate 重读（spec §4.3）
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
