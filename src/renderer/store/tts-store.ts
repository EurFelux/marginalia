import { create } from "zustand";
import type { TtsState } from "@renderer/reader/tts/tts-engine";

interface TtsUiState {
  /** TTS 会话状态（控制条显隐 + 播放/暂停按钮态）。由 tts-controller 单向写入。 */
  status: TtsState;
}

/** TTS 运行态发布（非持久化；偏好在 prefs-store.ttsPrefs）。 */
export const useTtsStore = create<TtsUiState>()(() => ({ status: "idle" }));
