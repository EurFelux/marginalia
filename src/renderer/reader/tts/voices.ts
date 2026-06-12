import { createLogger } from "@renderer/logger";
import type { SpeechPort, UtteranceLike } from "./tts-engine";
import type { TtsPlatform } from "./pick-voice";

const log = createLogger("tts");

/** 真 speechSynthesis 适配（接口见 tts-engine 的 SpeechPort）。 */
export function browserSpeechPort(): SpeechPort {
  const synth = window.speechSynthesis;
  return {
    createUtterance: (text) => new SpeechSynthesisUtterance(text) as unknown as UtteranceLike,
    speak: (u) => synth.speak(u as SpeechSynthesisUtterance),
    cancel: () => synth.cancel(),
    pause: () => synth.pause(),
    resume: () => synth.resume(),
  };
}

// 缓存不随运行期新装系统语音刷新（需重启 app）
let voicesCache: SpeechSynthesisVoice[] | null = null;

/**
 * getVoices() 首次调用可能返回空数组（spec §4.4）：等 voiceschanged，
 * 超时兜底返回当前列表（可能仍空——pickVoice 对空列表返回 null，引擎默认行为朗读）。
 */
export function getVoicesReady(timeoutMs = 2000): Promise<SpeechSynthesisVoice[]> {
  if (voicesCache?.length) return Promise.resolve(voicesCache);
  const synth = window.speechSynthesis;
  const now = synth.getVoices();
  if (now.length > 0) {
    voicesCache = now;
    return Promise.resolve(now);
  }
  return new Promise((resolve) => {
    const finish = (list: SpeechSynthesisVoice[]) => {
      voicesCache = list;
      resolve(list);
    };
    const timer = setTimeout(() => {
      log.warn("voiceschanged timed out, proceeding with current voice list");
      finish(synth.getVoices());
    }, timeoutMs);
    synth.addEventListener(
      "voiceschanged",
      () => {
        clearTimeout(timer);
        finish(synth.getVoices());
      },
      { once: true },
    );
  });
}

export function currentPlatform(): TtsPlatform {
  const p = navigator.platform.toLowerCase();
  if (p.includes("mac")) return "macos";
  if (p.includes("win")) return "windows";
  return "linux";
}
